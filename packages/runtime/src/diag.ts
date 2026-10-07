import { admitAgent, isUnattended, principalLabel, type Origin } from '@ge-slack/contracts';
import type { Orchestrator } from './orchestrator.js';
import { mrkdwnEscape } from './compile.js';
import { resolveGrounds } from './resolve.js';
import { licenceSummary } from './licence.js';

/**
 * `/gemini diag` (EXPERIENCE §10): run the real path as the invoker, in this channel, and report
 * what it found — identity, membership, a live Gemini Enterprise answer, connector authorization,
 * which agents this principal may use, and the service identity. Private, posts nothing, keeps no
 * session, and never shows a provider body or a token.
 */
export async function runDiagnostics(
  orch: Orchestrator,
  origin: Origin,
  as: 'me' | 'service' | undefined,
): Promise<string[]> {
  const { identity, config, surface, gemini } = orch.deps;
  const features = [...(orch.deps.features ?? [])].sort().join(', ') || 'none';
  const lines: string[] = [
    `🩺 *Gemini diagnostics* · build ${orch.deps.version ?? 'dev'} · features: ${features}`,
  ];
  const channel = origin.channelId;
  const [policy, info] = await Promise.all([
    config.channelPolicy(origin.teamId, channel ?? ''),
    channel ? surface.conversationInfo(channel) : Promise.resolve(undefined),
  ]);

  const resolved = await identity.resolve({
    teamId: origin.teamId,
    userId: origin.userId,
    policy: policy.identity,
    ...(as ? { requested: as } : {}),
    unattended: isUnattended(origin),
    externallyShared: Boolean(info?.isExtShared || origin.externallyShared),
  });
  if (!resolved.ok) {
    lines.push(
      `🔓 *Identity*  ${resolved.decision.message} (channel policy: ${policy.identity})`,
      '_Run `/gemini connect`, then `/gemini diag` again._',
    );
    return lines;
  }
  const principal = resolved.principal;
  lines.push(
    `✅ *Identity*  ${principal.kind === 'user' ? 'as you' : 'as the Gemini service'} · ${principalLabel(principal)} (channel policy: ${policy.identity}${info?.isExtShared ? ', Slack Connect → service' : ''})`,
  );

  if (principal.kind === 'user') {
    const licence = await licenceSummary(orch, origin.teamId, origin.userId, { fresh: true });
    if (licence) lines.push(licence.line);
  }

  if (channel) {
    const member = await surface.isMember(channel, origin.userId);
    if (!member) {
      // Nothing about this channel (sources, connectors) is checked for a non-member.
      lines.push(
        `🚫 *Access*  you're not a member of <#${channel}>, so Gemini can't read it for you`,
      );
      return lines;
    }
    lines.push(`✅ *Access*  you're a member of <#${channel}>`);
    if (principal.kind === 'service' && !policy.serviceMayRead) {
      lines.push(`🚫 *Access*  the Gemini service may not read <#${channel}> (App Home → Admin)`);
      return lines;
    }
  }

  const [catalog, unit, agents] = await Promise.all([
    config.catalog(origin.teamId),
    channel ? config.unit(origin.teamId, channel) : Promise.resolve(undefined),
    config.agents(origin.teamId),
  ]);
  const grounds = resolveGrounds(
    {
      verb: 'ask',
      inferredVerb: false,
      grounds: [],
      people: [],
      from: [],
      instruction: '',
      flags: {},
    },
    catalog,
    unit,
    principal,
    policy,
  );

  const started = Date.now();
  let answered = false;
  let failure: string | undefined;
  let unauthorized: string[] = [];
  for await (const e of gemini.stream(resolved.tokens, {
    text: 'Reply with the single word: ready',
    route: 'default',
    sessionless: true,
    dataStores: grounds.dataStores,
    identity: resolved.identity,
    signal: AbortSignal.timeout(60_000),
  })) {
    if (e.type === 'done') answered = true;
    else if (e.type === 'error') failure ??= diagError(e.code);
    else if (e.type === 'policy') failure ??= 'blocked by your Model Armor policy';
    else if (e.type === 'connector-auth') unauthorized = e.connectors;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  lines.push(
    answered && !failure
      ? `✅ *Gemini*  answered in ${secs} s`
      : `❌ *Gemini*  ${failure ?? 'the answer was cut off'}`,
  );
  const sourceNames = grounds.titles.length ? grounds.titles.map(mrkdwnEscape).join(', ') : 'none';
  lines.push(
    unauthorized.length
      ? `⚠️ *Sources*  @unit = ${sourceNames} · not authorized: ${unauthorized.slice(0, 5).map(oneLine).join(', ')}`
      : `✅ *Sources*  @unit = ${sourceNames}${grounds.warnings.length ? ` · ${grounds.warnings.length} warning(s)` : ''}`,
  );

  if (agents.length) {
    const verdicts = agents.map((a) => {
      const r = admitAgent(
        {
          verb: 'ask',
          grounds: [{ kind: 'alias', alias: a.alias }],
          principal: principal.kind,
          unattended: false,
          scope: 'thread',
          scopeNamed: false,
          externallyShared: Boolean(info?.isExtShared),
        },
        agents,
      );
      const alias = mrkdwnEscape(a.alias);
      if (!r.ok) return `🚫 @${alias} (${r.reason})`;
      return r.forwardContext ? `@${alias}` : `@${alias} (name a scope to share the thread)`;
    });
    lines.push(`✅ *Agents*  ${verdicts.join(' · ')}`);
  }

  if (principal.kind === 'user') {
    lines.push(
      identity.serviceConfigured
        ? `🏢 *Service*  ${identity.serviceAccount} configured · may read this channel: ${policy.serviceMayRead ? 'yes' : 'no'}`
        : '🏢 *Service*  no Gemini service identity configured',
    );
  }
  if (unauthorized.length && principal.kind === 'user' && orch.deps.appUrl) {
    lines.push(`→ <${orch.deps.appUrl}|Authorize sources in Gemini Enterprise> (Manage your data)`);
  }
  return lines;
}

function diagError(code: string): string {
  if (code === 'http_401') return 'http 401 — your Google token was rejected (reconnect)';
  if (code === 'http_403') {
    return 'http 403 — no Gemini Enterprise licence or IAM for this identity on this engine';
  }
  if (code === 'http_404') return 'http 404 — check GE_PROJECT / GE_LOCATION / GE_ENGINE';
  if (code === 'network') return 'could not reach Gemini Enterprise (network / proxy)';
  return code;
}

/** Connector names come from the engine: one bounded, escaped line. */
function oneLine(s: string): string {
  return mrkdwnEscape(
    s
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60),
  );
}
