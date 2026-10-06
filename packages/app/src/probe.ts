import type { AgentEntry, AssistEvent, GroundSource } from '@ge-slack/contracts';
import {
  A2aClient,
  StreamAssistClient,
  assistantResourceName,
  collectionResourceName,
  discoveryEngineHost,
  type AssistTurn,
  type GeminiClientConfig,
  type TokenSource,
} from '@ge-slack/gemini-client';

/**
 * Live probes against a real Gemini Enterprise engine (`bun run probe`): the checks ADR-0002 and
 * docs/STATUS.md list as "not yet run live", turned into one pass/fail report. Read-only: probes
 * never create, change or delete anything, and they never print tokens or response bodies beyond a
 * short, single-line excerpt of an error.
 */

export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: string;
}

export interface ProbeContext {
  gemini: GeminiClientConfig;
  sources: GroundSource[];
  agents: AgentEntry[];
  tokens: TokenSource;
  /** `user:…` / `service:…` — only stamped into provenance, never sent as a credential. */
  identity: string;
  fetchImpl?: typeof fetch;
  /** Connector collection id for the `invokeConnectorMcp` probe (e.g. `jira-fed_123`). */
  connector?: string;
  /** Run Deep Research phase 2 too (slow: minutes). */
  deepResearchRun?: boolean;
  /** Abort a single probe after this long (default 120 s). */
  timeoutMs?: number;
}

export const PROBE_NAMES = [
  'stream-assist',
  'grounding',
  'skills',
  'agents',
  'agent-views',
  'engine',
  'connector-mcp',
] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export async function runProbes(
  ctx: ProbeContext,
  only: ProbeName[] = [...PROBE_NAMES],
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const table: Record<ProbeName, () => Promise<ProbeResult[]>> = {
    'stream-assist': async () => [await probeStreamAssist(ctx)],
    grounding: async () => [await probeGrounding(ctx)],
    skills: () => probeSkills(ctx),
    agents: () => probeAgents(ctx),
    'agent-views': async () => [await probeAgentViews(ctx)],
    engine: async () => [await probeEngine(ctx)],
    'connector-mcp': async () => [await probeConnectorMcp(ctx)],
  };
  for (const name of only) {
    try {
      results.push(...(await table[name]()));
    } catch (err) {
      results.push({ name, status: 'fail', detail: oneLine(errorText(err)) });
    }
  }
  return results;
}

// ---------------------------------------------------------------- streamAssist

interface Collected {
  text: string;
  events: AssistEvent[];
  error?: string;
  done: boolean;
}

async function collect(
  ctx: ProbeContext,
  turn: Omit<AssistTurn, 'identity' | 'signal'>,
): Promise<Collected> {
  const signal = AbortSignal.timeout(ctx.timeoutMs ?? 120_000);
  const full: AssistTurn = { ...turn, identity: ctx.identity, signal };
  const stream =
    turn.agent?.kind === 'a2a'
      ? new A2aClient(ctx.gemini, ctx.fetchImpl).stream(ctx.tokens, full)
      : new StreamAssistClient(ctx.gemini, ctx.fetchImpl, { maxAttempts: 1 }).stream(
          ctx.tokens,
          full,
        );
  const out: Collected = { text: '', events: [], done: false };
  for await (const e of stream) {
    out.events.push(e);
    if (e.type === 'token') out.text += e.text;
    else if (e.type === 'error') out.error ??= `${e.code}: ${googleError(e.message)}`;
    else if (e.type === 'policy') out.error ??= 'blocked by Model Armor policy';
    else if (e.type === 'done') out.done = true;
  }
  return out;
}

async function probeStreamAssist(ctx: ProbeContext): Promise<ProbeResult> {
  const r = await collect(ctx, {
    text: 'Reply with the single word: ready',
    route: 'default',
    sessionless: true,
  });
  if (r.error || !r.done) {
    return {
      name: 'stream-assist',
      status: 'fail',
      detail: hint(r.error ?? 'stream ended without done'),
    };
  }
  return {
    name: 'stream-assist',
    status: 'pass',
    detail: `answered (${r.text.length} chars); actionSpec.actionDisabled and no isSessionLess accepted`,
  };
}

async function probeGrounding(ctx: ProbeContext): Promise<ProbeResult> {
  if (!ctx.sources.length) {
    return { name: 'grounding', status: 'skip', detail: 'no @ sources configured' };
  }
  const r = await collect(ctx, {
    text: 'What are the three most recent documents you can find? Cite them.',
    route: 'default',
    sessionless: true,
    dataStores: ctx.sources.map((s) => s.dataStore),
  });
  if (r.error || !r.done) {
    return { name: 'grounding', status: 'fail', detail: hint(r.error ?? 'no done') };
  }
  const citations = r.events.filter((e) => e.type === 'citation').length;
  const auth = r.events.find(
    (e): e is Extract<AssistEvent, { type: 'connector-auth' }> => e.type === 'connector-auth',
  );
  return {
    name: 'grounding',
    status: 'pass',
    detail:
      `${ctx.sources.length} data store(s), ${citations} citation(s)` +
      (auth
        ? `; connectorAuthErrors parsed: ${auth.connectors.map(oneLine).join(', ')}`
        : '; no connectorAuthErrors (all connectors authorized, or none federated)'),
  };
}

async function probeSkills(ctx: ProbeContext): Promise<ProbeResult[]> {
  const routes: Array<{ route: 'planner' | 'command'; mentions: unknown[] | undefined }> = [
    { route: 'planner', mentions: ctx.gemini.plannerSkillMentions },
    { route: 'command', mentions: ctx.gemini.commandSkillMentions },
  ];
  const out: ProbeResult[] = [];
  for (const { route, mentions } of routes) {
    const name = `skills:${route}`;
    if (!mentions?.length) {
      out.push({ name, status: 'skip', detail: 'skill mention not configured' });
      continue;
    }
    const r = await collect(ctx, {
      text:
        route === 'planner'
          ? 'Request: summarize this thread and post action items. Emit your plan block.'
          : 'Capabilities: reply. Request: reply "probe ok". Emit your cmd block.',
      route,
      sessionless: true,
    });
    if (r.error || !r.done) {
      out.push({
        name,
        status: 'fail',
        detail: hint(r.error ?? 'no done', ctx.gemini.skillAgentsSpec !== false),
      });
      continue;
    }
    const prov = r.events.find(
      (e): e is Extract<AssistEvent, { type: 'provenance' }> => e.type === 'provenance',
    );
    const invoked = prov?.payload.agentId.split('/').slice(1).join('/');
    const fenced = route === 'planner' ? /```plan/.test(r.text) : /```cmd/.test(r.text);
    out.push({
      name,
      status: invoked ? 'pass' : 'fail',
      detail: invoked
        ? `invokedSkills: ${invoked}${fenced ? '' : ' (no fenced block on turn 1 — the runtime re-prompts)'}`
        : 'skill was not invoked (invokedSkills empty): check the mention uri and that the skill is shared with this identity',
    });
  }
  return out;
}

async function probeAgents(ctx: ProbeContext): Promise<ProbeResult[]> {
  if (!ctx.agents.length) return [{ name: 'agents', status: 'skip', detail: 'no @ agents' }];
  const out: ProbeResult[] = [];
  for (const a of ctx.agents) {
    const name = `agent:@${a.alias} (${a.kind})`;
    const agent = { kind: a.kind, agentId: a.agentId };
    if (a.kind === 'a2a') {
      const card = await getJson(ctx, `${a2aBase(ctx, a.agentId)}/card`, 'GET');
      if (!card.ok) {
        out.push({ name, status: 'fail', detail: `agent card: ${card.detail}` });
        continue;
      }
      const r = await collect(ctx, { text: 'ping', route: 'default', agent });
      const wait = awaiting(r);
      out.push(
        r.error || !r.done
          ? { name, status: 'fail', detail: hint(r.error ?? 'no done') }
          : {
              name,
              status: 'pass',
              detail: `card ok; message:stream ${wait ? `paused (${wait.reason})` : 'completed'} (${r.text.length} chars)`,
            },
      );
      continue;
    }
    const r = await collect(ctx, {
      text: a.kind === 'deep-research' ? 'Research: what is Gemini Enterprise?' : 'Hello',
      route: 'default',
      sessionless: a.kind !== 'deep-research',
      agent,
    });
    if (r.error || !r.done) {
      out.push({ name, status: 'fail', detail: hint(r.error ?? 'no done') });
      continue;
    }
    if (a.kind !== 'deep-research') {
      out.push({ name, status: 'pass', detail: `agentsSpec answered (${r.text.length} chars)` });
      continue;
    }
    const wait = awaiting(r);
    if (!wait?.handle.session) {
      out.push({
        name,
        status: 'fail',
        detail: 'no RESEARCH_PLAN contentKind / session seen: Deep Research API allowlisting?',
      });
      continue;
    }
    if (!ctx.deepResearchRun) {
      out.push({
        name,
        status: 'pass',
        detail: 'research plan returned with a session (phase 2 skipped; --deep-research-run)',
      });
      continue;
    }
    const run = await collect(ctx, {
      text: 'Start Research',
      route: 'default',
      session: wait.handle.session,
      agent,
    });
    const files = run.events.filter((e) => e.type === 'file').length;
    out.push(
      run.error || !run.done
        ? { name, status: 'fail', detail: `phase 2: ${hint(run.error ?? 'no done')}` }
        : {
            name,
            status: 'pass',
            detail: `plan + report (${run.text.length} chars, ${files} file(s))`,
          },
    );
  }
  return out;
}

function awaiting(r: Collected) {
  return r.events.find(
    (e): e is Extract<AssistEvent, { type: 'awaiting' }> => e.type === 'awaiting',
  );
}

// ---------------------------------------------------------------- raw REST probes

async function probeAgentViews(ctx: ProbeContext): Promise<ProbeResult> {
  const name = 'agent-views';
  if (ctx.gemini.proxyUrl) return { name, status: 'skip', detail: 'not routed through proxyUrl' };
  const url = `${host(ctx)}/v1alpha/${assistantResourceName(ctx.gemini.assistant)}:listAvailableAgentViews`;
  const r = await getJson(ctx, url, 'POST', {});
  if (!r.ok) return { name, status: 'fail', detail: `listAvailableAgentViews: ${r.detail}` };
  const views = (Array.isArray(r.body.agentViews) ? r.body.agentViews : []) as Array<
    Record<string, unknown>
  >;
  const ids = new Set(
    views.map((v) =>
      String(v.name ?? '')
        .split('/')
        .at(-1),
    ),
  );
  const byType = new Map<string, number>();
  for (const v of views) {
    const t = String(v.agentType ?? 'UNKNOWN');
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const missing = ctx.agents.filter((a) => !ids.has(a.agentId)).map((a) => `@${a.alias}`);
  return {
    name,
    status: missing.length ? 'fail' : 'pass',
    detail:
      `${views.length} view(s) [${[...byType].map(([t, n]) => `${t}:${n}`).join(' ')}] (undocumented method)` +
      (missing.length ? `; not visible to this identity: ${missing.join(', ')}` : ''),
  };
}

async function probeEngine(ctx: ProbeContext): Promise<ProbeResult> {
  const name = 'engine';
  if (ctx.gemini.proxyUrl) return { name, status: 'skip', detail: 'not routed through proxyUrl' };
  const url = `${host(ctx)}/v1alpha/${engineName(ctx)}`;
  const r = await getJson(ctx, url, 'GET');
  if (!r.ok) return { name, status: 'fail', detail: `engines.get: ${r.detail}` };
  const ids = new Set((Array.isArray(r.body.dataStoreIds) ? r.body.dataStoreIds : []).map(String));
  const missing = ctx.sources
    .filter((s) => !ids.has(s.dataStore.split('/').at(-1) ?? ''))
    .map((s) => `@${s.alias}`);
  return {
    name,
    status: missing.length ? 'fail' : 'pass',
    detail:
      `${ids.size} data store(s) on the engine` +
      (missing.length ? `; sources not attached to this engine: ${missing.join(', ')}` : ''),
  };
}

async function probeConnectorMcp(ctx: ProbeContext): Promise<ProbeResult> {
  const name = 'connector-mcp';
  if (!ctx.connector) return { name, status: 'skip', detail: 'pass --connector <collection-id>' };
  if (!/^[A-Za-z0-9_-]+$/.test(ctx.connector)) {
    return { name, status: 'fail', detail: 'invalid connector collection id' };
  }
  if (ctx.gemini.proxyUrl) return { name, status: 'skip', detail: 'not routed through proxyUrl' };
  const base = collectionResourceName({ ...ctx.gemini.assistant, collection: ctx.connector });
  const url = `${host(ctx)}/v1alpha/${base}/dataConnector:invokeConnectorMcp`;
  // tools/list only: listing is read-only; tools/call is never probed.
  const r = await getJson(ctx, url, 'POST', {
    method: 'tools/list',
    params: {},
    engine: engineName(ctx),
  });
  if (!r.ok) return { name, status: 'fail', detail: `invokeConnectorMcp tools/list: ${r.detail}` };
  const result = (r.body.result ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(result.tools) ? result.tools : [];
  if (r.body.error) {
    return { name, status: 'fail', detail: `MCP error: ${oneLine(JSON.stringify(r.body.error))}` };
  }
  return { name, status: 'pass', detail: `${tools.length} tool(s) listed` };
}

function host(ctx: ProbeContext): string {
  return discoveryEngineHost(ctx.gemini.assistant.location);
}

function engineName(ctx: ProbeContext): string {
  return `${collectionResourceName(ctx.gemini.assistant)}/engines/${ctx.gemini.assistant.engine}`;
}

function a2aBase(ctx: ProbeContext, agentId: string): string {
  return `${host(ctx)}/v1/${assistantResourceName(ctx.gemini.assistant)}/agents/${agentId}/a2a/v1`;
}

async function getJson(
  ctx: ProbeContext,
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
  const f = ctx.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const res = await f(url, {
    method,
    headers: {
      Authorization: `Bearer ${await ctx.tokens.getAccessToken()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(ctx.timeoutMs ?? 120_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, detail: hint(`http_${res.status}: ${googleError(text)}`) };
  try {
    return { ok: true, body: (JSON.parse(text || '{}') ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, detail: 'response was not JSON' };
  }
}

/** Common failures → the likely cause, so the report is actionable on its own. */
function hint(detail: string, skillAgentsSpec = false): string {
  if (/http_401/.test(detail)) return `${detail} — token expired or wrong audience`;
  if (/http_403/.test(detail)) {
    return `${detail} — missing IAM (discoveryengine.assistants.assist) or a licence for this identity`;
  }
  if (/http_404/.test(detail)) return `${detail} — check GE_PROJECT/GE_LOCATION/GE_ENGINE`;
  if (/http_400/.test(detail) && /actionSpec|actionDisabled/i.test(detail)) {
    return `${detail} — this edition rejects actionSpec (ADR-0002 probe 3)`;
  }
  if (/http_5\d\d/.test(detail) && skillAgentsSpec) {
    return `${detail} — try GE_SKILL_AGENTS_SPEC=off (mention-only skill routing)`;
  }
  return detail;
}

/** Google API error bodies (object or streamed array) → `STATUS: message`, one line. */
export function googleError(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const first = (Array.isArray(parsed) ? parsed[0] : parsed) as
      { error?: { status?: string; message?: string } } | undefined;
    const e = first?.error;
    if (e?.message) return oneLine(`${e.status ? `${e.status}: ` : ''}${e.message}`);
  } catch {
    /* not JSON: fall through */
  }
  return oneLine(text);
}

const MAX_DETAIL = 240;
function oneLine(text: string): string {
  const t = text
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replace(/ya29\.[\w.-]+/g, '***')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1)}…` : t;
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function formatReport(results: ProbeResult[]): string {
  const icon: Record<ProbeStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' };
  const width = Math.max(...results.map((r) => r.name.length), 10);
  const lines = results.map((r) => `${icon[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const passed = results.filter((r) => r.status === 'pass').length;
  lines.push(
    '',
    `${passed} passed · ${failed} failed · ${results.length - passed - failed} skipped`,
  );
  return lines.join('\n');
}
