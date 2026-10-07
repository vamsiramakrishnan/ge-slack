import { randomBytes } from 'node:crypto';
import { FAQ_LIMITS, faqClean, type FaqRequest } from '@ge-slack/contracts';
import type { TokenSource } from '@ge-slack/gemini-client';
import type { KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from './orchestrator.js';
import type { FaqCardView, TurnSink } from './ports.js';
import type { StoredAnswer } from './stores.js';

/**
 * Thread → FAQ (ADR-0003 §5). A person drafts from an answer they got in an allowed public
 * channel; a steward publishes it; the curator service account writes the document. Answers that
 * may have used anyone's own sources can't be drafted: only service answers, or answers whose
 * citations are all Slack links, so nothing private reaches a shared data store.
 */

export interface FaqWriterPort {
  create(
    tokens: TokenSource,
    id: string,
    doc: {
      question: string;
      answer: string;
      sources: string[];
      drafter: string;
      approver: string;
      changeId: string;
      createdAt: string;
    },
  ): Promise<{ ok: true } | { ok: false; code: string }>;
  remove(tokens: TokenSource, id: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

export interface FaqOptions {
  writer: FaqWriterPort;
  /** The curator service account's tokens (never the licensed service account). */
  tokens: TokenSource;
  dataStoreTitle: string;
  /** Private, internal channel where stewards decide. */
  stewardsChannel: string;
  stewards: readonly string[];
  /** Public channels whose answers may become FAQs. */
  channels: readonly string[];
  /** The curator account's name, recorded as the principal of each publish in the ledger. */
  curator?: string;
}

export class FaqService {
  readonly stewards: ReadonlySet<string>;
  readonly channels: ReadonlySet<string>;
  constructor(
    private readonly kv: KeyValueStore,
    readonly opts: FaqOptions,
  ) {
    this.stewards = new Set(opts.stewards);
    this.channels = new Set(opts.channels);
  }
  get(teamId: string, id: string) {
    return this.kv.get<FaqRequest>(`faq/${teamId}/${id}`);
  }
  /** Published FAQs are kept for good, so they can always be removed (security review M4). */
  save(r: FaqRequest) {
    return this.kv.set(
      `faq/${r.teamId}/${r.id}`,
      r,
      r.status === 'published' ? {} : { ttlMs: FAQ_LIMITS.requestRetainMs },
    );
  }
  lock(teamId: string, id: string, keep = false) {
    return this.kv.set(
      `faqlock/${teamId}/${id}`,
      true,
      keep ? {} : { ttlMs: FAQ_LIMITS.requestRetainMs },
    );
  }
  take(teamId: string, id: string) {
    return this.kv.take<boolean>(`faqlock/${teamId}/${id}`);
  }
}

function enabled(orch: Orchestrator): FaqService | undefined {
  return orch.deps.features?.has('faq') ? orch.deps.faq : undefined;
}

/**
 * May this stored answer offer *Save as FAQ*? Only answers the Gemini service gave (shared,
 * allow-listed sources only), asked in a FAQ channel, that read nothing outside the FAQ channels,
 * and came from no agent and no workspace search (security review H1). `draftFaq` re-checks
 * every conversation it read is still public and internal.
 */
export function faqEligible(
  orch: Orchestrator,
  a: Pick<StoredAnswer, 'origin' | 'principal' | 'question' | 'readChannels' | 'agent' | 'search'>,
): boolean {
  const svc = enabled(orch);
  if (!svc || !a.origin.channelId || !svc.channels.has(a.origin.channelId)) return false;
  if (!a.question?.trim() || a.agent || a.search) return false;
  if (!a.principal.startsWith('service:')) return false;
  return (a.readChannels ?? []).every((c) => svc.channels.has(c));
}

function view(svc: FaqService, r: FaqRequest, error?: string): FaqCardView {
  return {
    requestId: r.id,
    drafterId: r.drafterId,
    question: r.question,
    answer: r.answer,
    sources: r.sources,
    channel: r.channel,
    readChannels: r.readChannels ?? [],
    dataStoreTitle: svc.opts.dataStoreTitle,
    status: r.status,
    ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
    ...(error ? { error } : {}),
  };
}

/** *Save as FAQ* on an answer: its asker drafts it for the stewards. */
export async function draftFaq(
  orch: Orchestrator,
  teamId: string,
  turnId: string,
  userId: string,
  sink: TurnSink,
): Promise<void> {
  const svc = enabled(orch);
  if (!svc) {
    await sink.notice('info', 'FAQs are switched off for this workspace.');
    return;
  }
  const a = await orch.deps.stores.getAnswer(turnId);
  if (!a || a.invokerId !== userId || a.teamId !== teamId) {
    await sink.notice('info', 'That answer expired, or isn’t yours.');
    return;
  }
  if (!faqEligible(orch, a)) {
    await sink.notice(
      'denied',
      'Only answers to a question in a FAQ channel, from shared sources, can become FAQs. Ask with --as service to use shared sources only.',
    );
    return;
  }
  const channel = a.origin.channelId!;
  const stewards = await orch.deps.surface
    .conversationInfo(svc.opts.stewardsChannel)
    .catch(() => undefined);
  for (const c of new Set([channel, ...(a.readChannels ?? [])])) {
    const info = await orch.deps.surface.conversationInfo(c).catch(() => undefined);
    if (!info || info.isPrivate || info.isExtShared || info.isIm) {
      await sink.notice('denied', 'FAQs come from public, internal channels only.');
      return;
    }
  }
  if (!stewards || !stewards.isPrivate || stewards.isExtShared) {
    await sink.notice('error', 'FAQ stewards aren’t set up correctly here. Ask your admin.');
    return;
  }
  if (!(await orch.deps.surface.isMember(channel, userId, { fresh: true }))) {
    await sink.notice('denied', `You're no longer a member of <#${channel}>.`);
    return;
  }
  const r: FaqRequest = {
    id: `faq-${randomBytes(8).toString('hex')}`,
    teamId,
    drafterId: userId,
    question: faqClean(a.question ?? '', FAQ_LIMITS.questionChars),
    answer: faqClean(a.text, FAQ_LIMITS.answerChars),
    sources: (a.sourceUris ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, FAQ_LIMITS.sources),
    channel,
    readChannels: [...new Set(a.readChannels ?? [])],
    status: 'open',
    at: orch.now().toISOString(),
  };
  if (!r.question || !r.answer) {
    await sink.notice('error', 'That answer has nothing left to publish once cleaned.');
    return;
  }
  await svc.save(r);
  const card = await orch.deps.surface
    .faqCard(svc.opts.stewardsChannel, view(svc, r))
    .catch(() => undefined);
  if (!card) {
    await svc.save({ ...r, status: 'failed' });
    await sink.notice('error', 'Couldn’t reach the stewards’ channel. Try again later.');
    return;
  }
  await svc.save({ ...r, card });
  await svc.lock(teamId, r.id);
  orch.observe(teamId, { kind: 'faq', outcome: 'drafted' });
  await sink.notice('info', '📚 Sent to the FAQ stewards. You’ll get a DM when it’s published.');
}

async function steward(orch: Orchestrator, svc: FaqService, userId: string): Promise<boolean> {
  return (
    svc.stewards.has(userId) &&
    (await orch.deps.surface.isMember(svc.opts.stewardsChannel, userId, { fresh: true }))
  );
}

/** Publish or reject from the stewards' card. Stewards only, once, from the card itself. */
export async function decideFaq(
  orch: Orchestrator,
  teamId: string,
  id: string,
  userId: string,
  decision: 'publish' | 'reject',
  sink: TurnSink,
  clicked?: { channel?: string; ts?: string },
): Promise<void> {
  const svc = enabled(orch);
  if (!svc) {
    await sink.notice('info', 'FAQs are switched off for this workspace.');
    return;
  }
  if (!(await steward(orch, svc, userId))) {
    await sink.notice('denied', 'Only FAQ stewards can publish or reject.');
    return;
  }
  const where = await orch.deps.surface
    .conversationInfo(svc.opts.stewardsChannel)
    .catch(() => undefined);
  if (!where || !where.isPrivate || where.isExtShared) {
    await sink.notice('error', 'The stewards’ channel must be private and internal.');
    return;
  }
  const r = await svc.get(teamId, id);
  if (!r || r.status !== 'open') {
    await sink.notice('info', 'Someone already decided that FAQ.');
    return;
  }
  if (clicked && (clicked.channel !== r.card?.channel || clicked.ts !== r.card?.ts)) {
    await sink.notice('denied', 'Decide FAQs from their card in the stewards’ channel.');
    return;
  }
  if (!(await svc.take(teamId, id))) {
    await sink.notice('info', 'Someone already decided that FAQ.');
    return;
  }
  const at = orch.now().toISOString();
  let reopen = true;
  try {
    if (decision === 'reject') {
      const done: FaqRequest = { ...r, status: 'rejected', decidedBy: userId, decidedAt: at };
      await svc.save(done);
      reopen = false;
      orch.observe(teamId, { kind: 'faq', outcome: 'rejected' });
      if (done.card)
        await orch.deps.surface
          .faqCard(done.card.channel, view(svc, done), done.card.ts)
          .catch(() => undefined);
      await orch.deps.surface
        .notifyUser(r.drafterId, {
          text: '✦ The FAQ you drafted wasn’t published by the stewards.',
        })
        .catch(() => undefined);
      return;
    }
    const w = await svc.opts.writer.create(svc.opts.tokens, r.id, {
      question: r.question,
      answer: r.answer,
      sources: r.sources,
      drafter: r.drafterId,
      approver: userId,
      changeId: r.id,
      createdAt: at,
    });
    if (!w.ok) {
      orch.observe(teamId, { kind: 'faq', outcome: 'failed', reason: w.code.slice(0, 40) });
      await sink.notice('error', `Gemini Enterprise didn’t accept the FAQ (${w.code}). Try again.`);
      return; // reopen stays true
    }
    const done: FaqRequest = {
      ...r,
      status: 'published',
      decidedBy: userId,
      decidedAt: at,
      documentId: r.id,
    };
    await svc.save(done);
    await svc.lock(teamId, `${id}-remove`, true);
    reopen = false;
    // A write others will read, outside Slack: it goes in the ledger like any other (M4).
    await orch.deps.stores.record({
      changeId: r.id,
      teamId,
      invokerId: r.drafterId,
      approvedBy: userId,
      approval: 'human',
      kind: 'faq',
      label: `Publish FAQ to ${svc.opts.dataStoreTitle}`,
      outcome: 'applied',
      ...(r.card ? { location: { channel: r.card.channel, ts: r.card.ts } } : {}),
      inverse: { op: 'not-reversible', reason: 'Remove it from the stewards’ card.' },
      principal: `service:${svc.opts.curator ?? 'faq-curator'}`,
      at,
    });
    orch.observe(teamId, { kind: 'faq', outcome: 'published' });
    if (done.card)
      await orch.deps.surface
        .faqCard(done.card.channel, view(svc, done), done.card.ts)
        .catch(() => undefined);
    await orch.deps.surface
      .notifyUser(r.drafterId, {
        text: `✅ Your FAQ is published to ${svc.opts.dataStoreTitle}: answers across Gemini Enterprise can use it now.`,
      })
      .catch(() => undefined);
  } finally {
    if (reopen) await svc.lock(teamId, id).catch(() => undefined);
  }
}

/** *Remove from Gemini Enterprise*: a steward undoes a published FAQ (deletes the document). */
export async function removeFaq(
  orch: Orchestrator,
  teamId: string,
  id: string,
  userId: string,
  sink: TurnSink,
): Promise<void> {
  const svc = enabled(orch);
  if (!svc || !(await steward(orch, svc, userId))) {
    await sink.notice('denied', 'Only FAQ stewards can remove FAQs.');
    return;
  }
  const r = await svc.get(teamId, id);
  if (!r || r.status !== 'published' || !(await svc.take(teamId, `${id}-remove`))) {
    await sink.notice('info', 'That FAQ isn’t published.');
    return;
  }
  const w = await svc.opts.writer.remove(svc.opts.tokens, r.documentId ?? r.id);
  if (!w.ok) {
    await svc.lock(teamId, `${id}-remove`, true);
    await sink.notice('error', `Gemini Enterprise didn’t remove it (${w.code}). Try again.`);
    return;
  }
  const done: FaqRequest = {
    ...r,
    status: 'removed',
    decidedBy: userId,
    decidedAt: orch.now().toISOString(),
  };
  await svc.save(done);
  const entry = await orch.deps.stores.getEntry(teamId, r.id);
  if (entry) {
    await orch.deps.stores.record({ ...entry, undoneAt: done.decidedAt!, undoneBy: userId });
  }
  orch.observe(teamId, { kind: 'faq', outcome: 'removed' });
  if (done.card)
    await orch.deps.surface
      .faqCard(done.card.channel, view(svc, done), done.card.ts)
      .catch(() => undefined);
}
