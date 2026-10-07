import { randomBytes, randomUUID } from 'node:crypto';
import {
  SUGGEST_LIMITS,
  looksLikeQuestion,
  principalLabel,
  type Automation,
  type Invocation,
  type Origin,
  type SourceRef,
} from '@ge-slack/contracts';
import { collectStream, contentHash } from '@ge-slack/gemini-client';
import type { Orchestrator } from './orchestrator.js';
import type { CapturedContext, CapturedMessage, TurnSink } from './ports.js';
import { sanitizeOutbound } from './compile.js';
import { composeChatPrompt } from './prompt.js';
import { resolveGrounds } from './resolve.js';
import { PLAN_TTL_MS, type PendingPlan } from './stores.js';
import { delegationOn, delegationVerdict, newGrant } from './delegation.js';
import { licenceGate } from './licence.js';

/**
 * Proactive turns (ADR-0003 §3): turns nobody clicked. They never read more than the person they
 * serve could read themselves, and nothing lands where others see it without a click.
 */

const DAY_MS = 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function bareInvocation(verb: Invocation['verb'], instruction: string): Invocation {
  return {
    verb,
    inferredVerb: false,
    grounds: [],
    people: [],
    from: [],
    instruction,
    flags: {},
  };
}

// ------------------------------------------------------------------ daily brief

export const BRIEF_INSTRUCTION =
  'Write my daily brief from these channels (last 24 hours): what changed, decisions made, ' +
  'questions or requests aimed at me, and what needs my attention today. Group by channel, ' +
  'most important first. Keep it short; say "quiet day" for channels with nothing notable.';

export const MAX_BRIEF_CHANNELS = 5;

/** App Home → *Daily brief*: one per person, as a delegated automation delivered to their DM. */
export async function createBrief(
  orch: Orchestrator,
  who: { teamId: string; userId: string },
  b: { dm: string; channels: string[]; hour: number; minute: number },
  sink: TurnSink,
): Promise<void> {
  const port = orch.deps.automations;
  if (!port || !orch.deps.features?.has('brief') || !delegationOn(orch)) {
    await sink.notice('info', 'The daily brief is switched off for this workspace.');
    return;
  }
  if (!(await orch.deps.identity.getLinked(who.teamId, who.userId))) {
    await sink.notice(
      'info',
      'Connect your account first (`/gemini connect`): the brief runs as you.',
    );
    return;
  }
  const channels = [...new Set(b.channels)];
  if (!channels.length || channels.length > MAX_BRIEF_CHANNELS) {
    await sink.notice('error', `Pick 1–${MAX_BRIEF_CHANNELS} channels.`);
    return;
  }
  if (!/^D[A-Z0-9]+$/.test(b.dm) || !Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) {
    await sink.notice('error', 'Pick a time for the brief.');
    return;
  }
  for (const c of channels) {
    const info = await orch.deps.surface.conversationInfo(c).catch(() => undefined);
    if (!info || info.isExtShared || info.isIm) {
      await sink.notice(
        'denied',
        `<#${c}> can't be in a brief (DMs and Slack Connect channels are left out).`,
      );
      return;
    }
    if (!(await orch.deps.surface.isMember(c, who.userId, { fresh: true }))) {
      await sink.notice('denied', `You're not a member of <#${c}>.`);
      return;
    }
  }
  if ((await port.list(who.teamId, who.userId)).some((a) => a.template === 'brief')) {
    await sink.notice(
      'info',
      'You already have a daily brief — delete it in App Home to set a new one.',
    );
    return;
  }
  const hh = String(b.hour).padStart(2, '0');
  const mm = String(b.minute).padStart(2, '0');
  const tz = orch.deps.timeZone ?? 'UTC';
  const a = await port.create({
    teamId: who.teamId,
    ownerId: who.userId,
    channelId: b.dm,
    trigger: {
      kind: 'schedule',
      text: `weekdays ${hh}:${mm}`,
      cron: `${b.minute} ${b.hour} * * 1-5`,
      timeZone: tz,
    },
    invocation: bareInvocation('summarize', BRIEF_INSTRUCTION),
    runAs: 'me',
    destination: b.dm,
    enabled: true,
    template: 'brief',
  });
  const grant = await newGrant(orch, a, channels);
  if (!grant) {
    await port.update({ ...a, enabled: false, suspendedReason: 'owner not connected' });
    await sink.notice('error', 'Connect your account first, then set up the brief.');
    return;
  }
  await port.update({ ...a, grant });
  orch.observe(who.teamId, { kind: 'brief', outcome: 'created' });
  await sink.notice(
    'info',
    `☀️ Daily brief set for weekdays ${hh}:${mm} (${tz}) in this DM, from ${channels.map((c) => `<#${c}>`).join(', ')}. It runs as you until ${grant.expiresAt.slice(0, 10)}; renew it in App Home.`,
  );
}

/** One brief run: as the owner under their grant, reading only granted channels they're still in. */
export async function runBrief(orch: Orchestrator, a: Automation, sink: TurnSink): Promise<void> {
  if (!orch.deps.features?.has('brief') || !delegationOn(orch)) {
    await sink.notice('info', 'The daily brief is switched off for this workspace.');
    return;
  }
  const dm = a.destination;
  const channels = a.grant?.channels ?? [];
  if (!dm || !channels.length) {
    await sink.notice('error', 'This brief has no channels or destination.');
    return;
  }
  const origin: Origin = {
    entry: 'schedule',
    teamId: a.teamId,
    userId: a.ownerId,
    channelId: dm,
    automationId: a.id,
  };
  const v = await delegationVerdict(orch, a, { reads: channels, writes: [dm] });
  if (!v.ok) {
    await sink.notice('denied', v.message);
    return;
  }
  const resolved = await orch.deps.identity.resolve({
    teamId: a.teamId,
    userId: a.ownerId,
    policy: 'user-only',
    requested: 'me',
    unattended: true,
    externallyShared: false,
    delegated: true,
  });
  if (!resolved.ok || resolved.principal.kind !== 'user') {
    await sink.notice(
      'denied',
      resolved.ok ? 'The brief must run as you.' : resolved.decision.message,
    );
    return;
  }
  const inv: Invocation = {
    ...bareInvocation('summarize', BRIEF_INSTRUCTION),
    flags: { as: 'me', to: dm, visibility: 'public' },
  };
  if (!(await licenceGate(orch, inv, origin, sink, false))) return;

  const messages: CapturedMessage[] = [];
  let truncated = false;
  for (const c of channels) {
    const info = await orch.deps.surface.conversationInfo(c).catch(() => undefined);
    if (!info || info.isExtShared) continue;
    const ctx = await orch.deps.surface
      .capture({ kind: 'channel', channel: c, sinceMs: DAY_MS }, { from: [], maxMessages: 60 })
      .catch(() => undefined);
    if (!ctx) continue;
    truncated ||= ctx.truncated;
    messages.push(...ctx.messages.map((m) => ({ ...m, channel: m.channel ?? c })));
  }
  const ctx: CapturedContext = {
    label: `Daily brief · ${channels.length} channel${channels.length === 1 ? '' : 's'} · last 24h`,
    messages,
    truncated,
  };
  const r = await collectStream(
    orch.deps.gemini.stream(resolved.tokens, {
      text: composeChatPrompt(inv, ctx, []),
      route: 'default',
      sessionless: true,
      dataStores: [],
      identity: resolved.identity,
    }),
  );
  if (r.blocked || r.error || !r.complete) {
    await sink.notice(
      'error',
      'Today’s brief couldn’t be written (Gemini Enterprise didn’t finish).',
    );
    return;
  }
  const text = sanitizeOutbound(r.text, orch.knownUsers(ctx, inv, origin));
  orch.observe(a.teamId, { kind: 'brief', outcome: 'sent' });
  await orch.landUnattendedAnswer(text, r.sources, r.provenance?.agentId, inv, origin, sink, {
    principal: resolved.principal,
    tokens: resolved.tokens,
    identity: resolved.identity,
    badge: { kind: 'user', label: principalLabel(resolved.principal) },
    scope: { kind: 'none' },
    grounds: { dataStores: [], titles: [], warnings: [] },
    ctx,
    allowedChannels: new Set([dm]),
    readChannels: new Set(channels),
    externallyShared: false,
    forwardContext: true,
    memory: [],
    serviceFallback: false,
    ...(a.grant ? { grantExpiresAt: a.grant.expiresAt } : {}),
  });
}

// ------------------------------------------------------------------ suggested answers

interface QueuedQuestion {
  channel: string;
  ts: string;
  userId: string;
  dueAt: number;
}

export interface StoredSuggestion {
  id: string;
  teamId: string;
  channel: string;
  ts: string;
  askerId: string;
  text: string;
  sources: SourceRef[];
  at: string;
}

export const SUGGEST_INSTRUCTION =
  'Answer the question at the top of this thread using only the sources you have and the ' +
  'thread itself. Be brief and cite sources. If the sources don’t clearly answer it, reply ' +
  'with exactly NO_ANSWER and nothing else.';

const enabled = (orch: Orchestrator) => Boolean(orch.deps.features?.has('suggestions'));

/** A new top-level message in a channel: queue it if it reads like a question (ADR-0003 §3). */
export async function queueQuestion(
  orch: Orchestrator,
  ev: {
    teamId: string;
    channel: string;
    ts: string;
    threadTs?: string;
    userId?: string;
    text: string;
    fromBot: boolean;
  },
): Promise<boolean> {
  if (!enabled(orch) || ev.fromBot || !ev.userId || ev.threadTs) return false;
  if (!looksLikeQuestion(ev.text)) return false;
  const policy = await orch.deps.config.channelPolicy(ev.teamId, ev.channel);
  if (!policy.suggest || !policy.serviceMayRead || !orch.deps.identity.serviceConfigured)
    return false;
  const kv = orch.deps.stores.kv;
  const now = orch.now().getTime();
  const chanKey = `suggestn/${ev.teamId}/c/${ev.channel}/${day(now)}`;
  const userKey = `suggestn/${ev.teamId}/u/${ev.userId}/${day(now)}`;
  const [nc, nu] = await Promise.all([kv.get<number>(chanKey), kv.get<number>(userKey)]);
  if ((nc ?? 0) >= SUGGEST_LIMITS.perChannelPerDay || (nu ?? 0) >= SUGGEST_LIMITS.perAskerPerDay) {
    return false;
  }
  await Promise.all([
    kv.set(chanKey, (nc ?? 0) + 1, { ttlMs: 2 * DAY_MS }),
    kv.set(userKey, (nu ?? 0) + 1, { ttlMs: 2 * DAY_MS }),
  ]);
  const q: QueuedQuestion = {
    channel: ev.channel,
    ts: ev.ts,
    userId: ev.userId,
    dueAt: now + SUGGEST_LIMITS.delayMs,
  };
  await kv.set(`suggestq/${ev.teamId}/${ev.channel}-${ev.ts}`, q, { ttlMs: 2 * DAY_MS });
  orch.observe(ev.teamId, { kind: 'suggest', outcome: 'queued' });
  return true;
}

/** Cron: suggest answers to queued questions that are due and still unanswered. */
export async function processSuggestions(orch: Orchestrator, teamId: string): Promise<number> {
  if (!enabled(orch)) return 0;
  const kv = orch.deps.stores.kv;
  const now = orch.now().getTime();
  let n = 0;
  for (const { key, value } of await kv.list<QueuedQuestion>(`suggestq/${teamId}/`)) {
    if (value.dueAt > now) continue;
    const q = await kv.take<QueuedQuestion>(key); // one instance handles each question
    if (!q) continue;
    if (await suggestFor(orch, teamId, q).catch(() => false)) n++;
  }
  return n;
}

async function suggestFor(orch: Orchestrator, teamId: string, q: QueuedQuestion): Promise<boolean> {
  const { config, surface, identity } = orch.deps;
  const skip = (why: string) => {
    orch.observe(teamId, { kind: 'suggest', outcome: 'skipped', reason: why });
    return false;
  };
  const policy = await config.channelPolicy(teamId, q.channel);
  if (!policy.suggest || !policy.serviceMayRead) return skip('policy');
  const info = await surface.conversationInfo(q.channel);
  if (info.isExtShared || info.isIm) return skip('slack-connect');
  if (!(await surface.isMember(q.channel, q.userId))) return skip('not-member');
  if ((await orch.deps.licences?.cached(teamId, q.userId)) === 'blocked') return skip('blocked');
  const ctx = await surface.capture(
    { kind: 'thread', channel: q.channel, ts: q.ts },
    { from: [], maxMessages: 50 },
  );
  // A human already answered: stay out of it.
  if (ctx.messages.some((m) => m.ts !== q.ts && !m.fromApp && m.user && m.user !== q.userId)) {
    return skip('answered');
  }
  const resolved = await identity.resolve({
    teamId,
    userId: q.userId,
    policy: policy.identity,
    requested: 'service',
    unattended: true,
    externallyShared: false,
  });
  if (!resolved.ok || resolved.principal.kind !== 'service') return skip('service-policy');
  const [catalog, unit] = await Promise.all([
    config.catalog(teamId),
    config.unit(teamId, q.channel),
  ]);
  const inv = bareInvocation('ask', SUGGEST_INSTRUCTION);
  const grounds = resolveGrounds(inv, catalog, unit, resolved.principal, policy);
  const origin: Origin = {
    entry: 'keyword',
    teamId,
    userId: q.userId,
    channelId: q.channel,
    threadTs: q.ts,
  };
  const r = await collectStream(
    orch.deps.gemini.stream(resolved.tokens, {
      text: composeChatPrompt(inv, ctx, []),
      route: 'default',
      sessionless: true,
      dataStores: grounds.dataStores,
      identity: resolved.identity,
    }),
  );
  if (r.blocked || r.error || !r.complete) return skip('provider');
  const text = sanitizeOutbound(r.text, orch.knownUsers(ctx, inv, origin)).trim();
  if (!text || /NO_ANSWER/.test(text) || text.length < 20) return skip('no-answer');
  const s: StoredSuggestion = {
    id: randomBytes(10).toString('hex'),
    teamId,
    channel: q.channel,
    ts: q.ts,
    askerId: q.userId,
    text: text.slice(0, 3800),
    sources: r.sources.slice(0, 10),
    at: orch.now().toISOString(),
  };
  await orch.deps.stores.kv.set(`suggest/${teamId}/${s.id}`, s, { ttlMs: SUGGEST_LIMITS.ttlMs });
  await surface.suggestPrivately(q.channel, q.userId, q.ts, {
    suggestionId: s.id,
    text: s.text,
    sources: s.sources.slice(0, 5),
    serviceLabel: principalLabel(resolved.principal),
  });
  orch.observe(teamId, { kind: 'suggest', outcome: 'offered' });
  return true;
}

/** *Post as answer*: the asker approves posting the suggestion in their thread, as the service. */
export async function postSuggestion(
  orch: Orchestrator,
  teamId: string,
  id: string,
  clickerId: string,
  sink: TurnSink,
): Promise<void> {
  const kv = orch.deps.stores.kv;
  const key = `suggest/${teamId}/${id}`;
  const peek = await kv.get<StoredSuggestion>(key);
  if (!peek || peek.askerId !== clickerId) {
    await sink.notice('info', 'That suggestion expired, or isn’t yours to post.');
    return;
  }
  const s = await kv.take<StoredSuggestion>(key);
  if (!s) {
    await sink.notice('info', 'That suggestion was already posted.');
    return;
  }
  const policy = await orch.deps.config.channelPolicy(teamId, s.channel);
  const info = await orch.deps.surface.conversationInfo(s.channel);
  if (!policy.suggest || !policy.serviceMayRead || info.isExtShared) {
    await sink.notice('denied', 'Suggestions are no longer allowed in this channel.');
    return;
  }
  if (!(await orch.deps.surface.isMember(s.channel, clickerId, { fresh: true }))) {
    await sink.notice('denied', `You're no longer a member of <#${s.channel}>.`);
    return;
  }
  const resolved = await orch.deps.identity.resolve({
    teamId,
    userId: clickerId,
    policy: policy.identity,
    requested: 'service',
    unattended: false,
    externallyShared: false,
  });
  if (!resolved.ok || resolved.principal.kind !== 'service') {
    await sink.notice('denied', 'The Gemini service can’t post here any more.');
    return;
  }
  const origin: Origin = {
    entry: 'button',
    teamId,
    userId: clickerId,
    channelId: s.channel,
    threadTs: s.ts,
  };
  const createdAt = orch.now().getTime();
  const plan: PendingPlan = {
    id: randomBytes(10).toString('hex'),
    teamId,
    invokerId: clickerId,
    origin,
    invocation: bareInvocation('ask', SUGGEST_INSTRUCTION),
    scope: { kind: 'thread', channel: s.channel, ts: s.ts },
    effects: [
      {
        changeId: `chg_${randomUUID()}`,
        params: { kind: 'reply', channel: s.channel, threadTs: s.ts, text: s.text },
        line: 'reply "…"',
        label: 'Reply in thread',
        preview: s.text.replace(/\s+/g, ' ').slice(0, 140),
        approvalClass: 'in-conversation',
        reversible: true,
      },
    ],
    sources: s.sources,
    agentId: 'gemini-enterprise',
    contentHash: await contentHash(s.text),
    identity: resolved.identity,
    dryRun: false,
    createdAt,
    expiresAt: createdAt + PLAN_TTL_MS,
  };
  orch.observe(teamId, { kind: 'suggest', outcome: 'posted' });
  await orch.apply(
    plan,
    resolved.identity,
    { kind: 'service', label: principalLabel(resolved.principal) },
    sink,
    { approval: 'human', approvedBy: clickerId },
  );
}

export async function dismissSuggestion(
  orch: Orchestrator,
  teamId: string,
  id: string,
  clickerId: string,
) {
  const key = `suggest/${teamId}/${id}`;
  const s = await orch.deps.stores.kv.get<StoredSuggestion>(key);
  if (s && s.askerId === clickerId) {
    await orch.deps.stores.kv.delete(key);
    orch.observe(teamId, { kind: 'suggest', outcome: 'dismissed' });
  }
}
