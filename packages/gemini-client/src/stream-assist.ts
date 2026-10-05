import type { AnswerProvenance, AssistEvent, SourceRef } from '@ge-slack/contracts';
import { streamAssistUrl, type GeminiClientConfig, type GeminiSkillRoute } from './config.js';
import { DeStreamAssistResponseSchema } from './de-types.js';
import { parseJsonArrayStream } from './json-stream.js';
import { contentHash } from './hash.js';
import { withRetry, defaultIsRetriable, HttpError, type RetryOptions } from './retry.js';
import { safeText, type TokenSource } from './token-source.js';

/** One provider turn, already composed by the runtime (context framed as data). */
export interface AssistTurn {
  /** The full query text: delimited Slack context (data) + the request. */
  text: string;
  route: GeminiSkillRoute;
  /** Data store resource names resolved from the turn's grounds. */
  dataStores?: string[];
  /** Restrict grounding to a NotebookLM notebook. */
  notebookId?: string;
  /** Resume a conversation (agent DM threads). Mutually exclusive with `sessionless`. */
  session?: string;
  /** Planner/command turns are isolated v1alpha requests (ge-msft default). */
  sessionless?: boolean;
  /** Provenance identity string, e.g. `user:alex@acme.com` / `service:ge@p.iam…`. */
  identity: string;
  signal?: AbortSignal;
}

class StreamRequestError extends Error {}

/**
 * Calls Gemini Enterprise `:streamAssist` as the turn's principal and re-shapes the streamed JSON
 * array into `AssistEvent`s (tokens → citations → provenance → done). The engine owns grounding,
 * Model Armor, and agent routing; this client owns transport + mapping only. Ported from ge-msft.
 */
export class StreamAssistClient {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly retryOpts: RetryOptions = {},
  ) {}

  async *stream(tokens: TokenSource, turn: AssistTurn): AsyncGenerator<AssistEvent> {
    let res: Response;
    try {
      res = await this.post(tokens, turn);
    } catch (err) {
      yield {
        type: 'error',
        code: err instanceof StreamRequestError ? 'invalid_request' : 'network',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }
    if (!res.ok || !res.body) {
      yield {
        type: 'error',
        code: `http_${res.status}`,
        message: (await safeText(res)) || `streamAssist failed (${res.status})`,
      };
      return;
    }

    let accumulated = '';
    const citations = new Map<string, SourceRef>();
    let session = turn.sessionless ? undefined : turn.session;
    const invokedSkills: string[] = [];
    const related: string[] = [];
    let blocked = false;
    let failed = false;

    try {
      for await (const chunk of parseJsonArrayStream(res.body)) {
        const parsed = DeStreamAssistResponseSchema.safeParse(chunk);
        if (!parsed.success) continue;
        const data = parsed.data;
        if (!turn.sessionless) session = data.sessionInfo?.session ?? session;
        for (const s of data.invokedSkills ?? []) {
          const name = s.displayName ?? s.name;
          if (name && !invokedSkills.includes(name)) invokedSkills.push(name);
        }
        // Model Armor block: surface once, then suppress everything else from this turn.
        const policy = data.answer?.customerPolicyEnforcementResult;
        if (!blocked && policy?.verdict?.toUpperCase() === 'BLOCK') {
          blocked = true;
          yield {
            type: 'policy',
            verdict: 'block',
            reason: "Gemini Enterprise's policy blocked this response.",
          };
        }
        if (blocked) continue;
        if (data.answer?.state === 'FAILED' && !failed) {
          failed = true;
          yield {
            type: 'error',
            code: 'assist_failed',
            message: 'Gemini Enterprise could not answer.',
          };
        }
        for (const q of data.answer?.relatedQuestions ?? []) {
          if (q && !related.includes(q)) related.push(q);
        }
        for (const reply of data.answer?.replies ?? []) {
          const gc = reply.groundedContent;
          const content = gc?.content;
          const text = content?.text;
          if (text && content?.thought === true) {
            const activity = compact(text);
            if (activity) yield { type: 'activity', text: activity };
          } else if (text) {
            accumulated += text;
            yield { type: 'token', text };
          }
          for (const ref of gc?.textGroundingMetadata?.references ?? []) {
            const dm = ref.documentMetadata;
            if (!dm) continue;
            const excerpt = ref.content ? truncateExcerpt(ref.content) : undefined;
            const source: SourceRef = {
              title: dm.title ?? dm.uri ?? dm.domain ?? 'Source',
              ...(dm.uri ? { uri: dm.uri } : {}),
              ...(dm.pageIdentifier ? { locator: dm.pageIdentifier } : {}),
              ...(excerpt ? { excerpt } : {}),
            };
            const key = source.uri ?? `${source.title}#${source.locator ?? ''}`;
            if (!citations.has(key)) {
              citations.set(key, source);
              yield { type: 'citation', source };
            }
          }
        }
      }
    } catch (err) {
      // A mid-stream failure is not retriable and the turn is incomplete: no provenance, no done.
      yield {
        type: 'error',
        code: 'stream_interrupted',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    if (blocked || failed) {
      yield { type: 'done' };
      return;
    }
    if (related.length) yield { type: 'related-questions', questions: related };
    const payload: AnswerProvenance = {
      agentId: agentId(this.config, invokedSkills),
      identity: turn.identity,
      timestamp: new Date().toISOString(),
      sources: [...citations.values()].map((s) => ({
        title: s.title,
        ...(s.uri ? { uri: s.uri } : {}),
        ...(s.locator ? { locator: s.locator } : {}),
      })),
      contentHash: await contentHash(accumulated),
      ...(session ? { sessionId: session } : {}),
    };
    yield { type: 'provenance', payload };
    yield { type: 'done' };
  }

  private async post(tokens: TokenSource, turn: AssistTurn): Promise<Response> {
    const url = streamAssistUrl(this.config);
    const body = JSON.stringify(buildStreamAssistRequest(turn, this.config));
    const send = async (): Promise<Response> => {
      const token = await tokens.getAccessToken();
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        ...(turn.signal ? { signal: turn.signal } : {}),
      });
      if (res.status !== 401 && defaultIsRetriable(new HttpError(res.status, ''))) {
        throw new HttpError(res.status, `streamAssist failed (${res.status})`);
      }
      return res;
    };
    let res: Response;
    try {
      res = await withRetry(send, this.retryOpts);
    } catch (err) {
      if (err instanceof HttpError) return new Response(null, { status: err.status });
      throw err;
    }
    if (res.status === 401 && tokens.invalidate) {
      tokens.invalidate();
      res = await send().catch((err) =>
        err instanceof HttpError ? new Response(null, { status: err.status }) : Promise.reject(err),
      );
    }
    return res;
  }
}

/** Map a composed turn onto a Discovery Engine `StreamAssistRequest`. */
export function buildStreamAssistRequest(
  turn: AssistTurn,
  cfg: GeminiClientConfig,
): Record<string, unknown> {
  if (turn.sessionless && turn.session && turn.session !== '-') {
    throw new StreamRequestError('Sessionless requests cannot resume an existing session.');
  }
  const { resources, mentions } = skillsForRoute(cfg, turn.route);
  const mentionText = mentions.length
    ? mentions.map((m) => `[${m.label}](mention://?uri=${encodeURIComponent(m.uri)})`).join(' ')
    : '';
  const out: Record<string, unknown> = {
    query: { text: mentionText ? `${mentionText} ${turn.text}` : turn.text || ' ' },
  };
  if (turn.sessionless) out.isSessionLess = true;
  else if (turn.session) out.session = turn.session;
  if (cfg.modelId) out.generationSpec = { modelId: cfg.modelId };
  if (resources.length) {
    out.agentsSpec = {
      agentSpecs: resources.map((name) => ({ agentId: name.split('/').at(-1) ?? name })),
    };
  }
  const dataStoreSpecs = (turn.dataStores ?? []).map((dataStore) => ({ dataStore }));
  const filter = turn.notebookId
    ? `notebookId: ANY("${turn.notebookId.replace(/"/g, '')}")`
    : undefined;
  if (filter || dataStoreSpecs.length) {
    out.toolsSpec = {
      vertexAiSearchSpec: {
        ...(filter ? { filter } : {}),
        ...(dataStoreSpecs.length ? { dataStoreSpecs } : {}),
      },
    };
  }
  return out;
}

function skillsForRoute(
  cfg: GeminiClientConfig,
  route: GeminiSkillRoute,
): { resources: string[]; mentions: NonNullable<GeminiClientConfig['skillMentions']> } {
  switch (route) {
    case 'planner':
      return { resources: cfg.plannerSkills ?? [], mentions: cfg.plannerSkillMentions ?? [] };
    case 'command':
      return { resources: cfg.commandSkills ?? [], mentions: cfg.commandSkillMentions ?? [] };
    default:
      return { resources: cfg.skills ?? [], mentions: cfg.skillMentions ?? [] };
  }
}

function agentId(cfg: GeminiClientConfig, skills: string[]): string {
  const base = `gemini-enterprise:${cfg.assistant.engine}`;
  return skills.length ? `${base}/${skills.join('+')}` : base;
}

function compact(text: string): string | undefined {
  const c = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  if (!c) return undefined;
  return c.length > 160 ? `${c.slice(0, 157)}...` : c;
}

const MAX_EXCERPT_CHARS = 300;
/** Source excerpts are untrusted: one line, no control/bidi characters, bounded. */
export function truncateExcerpt(raw: string): string | undefined {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_EXCERPT_CHARS
    ? `${text.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`
    : text;
}

/** Collect a full stream into text + sources (planner/command turns that aren't shown live). */
export async function collectStream(events: AsyncIterable<AssistEvent>): Promise<{
  text: string;
  sources: SourceRef[];
  provenance?: AnswerProvenance;
  error?: { code: string; message: string };
  blocked: boolean;
  complete: boolean;
}> {
  let text = '';
  const sources: SourceRef[] = [];
  let provenance: AnswerProvenance | undefined;
  let error: { code: string; message: string } | undefined;
  let blocked = false;
  let complete = false;
  for await (const e of events) {
    if (e.type === 'token') text += e.text;
    else if (e.type === 'citation') sources.push(e.source);
    else if (e.type === 'provenance') provenance = e.payload;
    else if (e.type === 'policy') blocked = true;
    else if (e.type === 'error') error ??= { code: e.code, message: e.message };
    else if (e.type === 'done') complete = true;
  }
  return {
    text,
    sources,
    ...(provenance ? { provenance } : {}),
    ...(error ? { error } : {}),
    blocked,
    complete,
  };
}
