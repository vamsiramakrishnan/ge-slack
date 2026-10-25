import { randomBytes } from 'node:crypto';
import { FAQ_LIMITS, faqClean, type FaqRequest } from '@ge-slack/contracts';
import { contentHash, type TokenSource } from '@ge-slack/gemini-client';
import type { KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from './orchestrator.js';
import type { FaqCardView, TurnSink } from './ports.js';
import type { LedgerEntry, StoredAnswer } from './stores.js';

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

/** Recheck the disclosure destination after any provider/storage wait, immediately before I/O. */
async function safeFaqCard(
  orch: Orchestrator,
  svc: FaqService,
  r: FaqRequest,
  card?: { channel: string; ts: string },
): Promise<{ channel: string; ts: string } | undefined> {
  const channel = card?.channel ?? svc.opts.stewardsChannel;
  if (channel !== svc.opts.stewardsChannel) return undefined;
  const info = await orch.deps.surface
    .conversationInfo(channel, { fresh: true })
    .catch(() => undefined);
  if (!info || !info.isPrivate || info.isExtShared || info.isIm || info.isMpim) return undefined;
  return orch.deps.surface.faqCard(channel, view(svc, r), card?.ts).catch(() => undefined);
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
    .conversationInfo(svc.opts.stewardsChannel, { fresh: true })
    .catch(() => undefined);
  for (const c of new Set([channel, ...(a.readChannels ?? [])])) {
    const info = await orch.deps.surface
      .conversationInfo(c, { fresh: true })
      .catch(() => undefined);
    if (
      !info ||
      info.isPrivate ||
      info.isExtShared ||
      info.isIm ||
      info.isMpim ||
      !(await orch.deps.surface.isMember(c, userId, { fresh: true }))
    ) {
      await sink.notice('denied', 'FAQs come from public, internal channels you can still read.');
      return;
    }
  }
  if (
    !stewards ||
    !stewards.isPrivate ||
    stewards.isExtShared ||
    stewards.isIm ||
    stewards.isMpim
  ) {
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
  const card = await safeFaqCard(orch, svc, r);
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

async function sourcesStillReadable(
  orch: Orchestrator,
  svc: FaqService,
  r: FaqRequest,
): Promise<boolean> {
  for (const channel of new Set([r.channel, ...(r.readChannels ?? [])])) {
    const info = await orch.deps.surface
      .conversationInfo(channel, { fresh: true })
      .catch(() => undefined);
    if (
      !svc.channels.has(channel) ||
      !info ||
      info.isPrivate ||
      info.isExtShared ||
      info.isIm ||
      info.isMpim ||
      !(await orch.deps.surface.isMember(channel, r.drafterId, { fresh: true }).catch(() => false))
    )
      return false;
  }
  return true;
}

function publishEntry(svc: FaqService, r: FaqRequest, approvedBy: string, at: string): LedgerEntry {
  return {
    changeId: r.id,
    teamId: r.teamId,
    invokerId: r.drafterId,
    approvedBy,
    approval: 'human',
    kind: 'faq',
    label: `Publish FAQ to ${svc.opts.dataStoreTitle}`,
    outcome: 'applied',
    ...(r.card ? { location: { channel: r.card.channel, ts: r.card.ts } } : {}),
    inverse: { op: 'not-reversible', reason: 'Remove it from the stewards’ card.' },
    principal: `service:${svc.opts.curator ?? 'faq-curator'}`,
    at,
  };
}

async function claimFaq(
  orch: Orchestrator,
  svc: FaqService,
  r: FaqRequest,
  direction: 'apply' | 'undo',
  intent: unknown,
  at: string,
  sink: TurnSink,
): Promise<boolean> {
  try {
    const claimed = await orch.deps.stores.claimEffect({
      version: 1,
      direction,
      teamId: r.teamId,
      changeId: r.id,
      invokerId: r.drafterId,
      principalHash: await contentHash(`service:${svc.opts.curator ?? 'faq-curator'}`),
      intentHash: await contentHash(JSON.stringify(intent)),
      kind: 'faq',
      startedAt: at,
    });
    if (claimed) return true;
    await sink.notice(
      'info',
      'This FAQ change was already claimed. Inspect its existing outcome before another change.',
    );
  } catch {
    await sink.notice('error', 'Could not durably claim this FAQ change; nothing was dispatched.');
  }
  return false;
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
    .conversationInfo(svc.opts.stewardsChannel, { fresh: true })
    .catch(() => undefined);
  if (!where || !where.isPrivate || where.isExtShared || where.isIm || where.isMpim) {
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
      if (done.card) await safeFaqCard(orch, svc, done, done.card);
      await orch.deps.surface
        .notifyUser(r.drafterId, {
          text: '✦ The FAQ you drafted wasn’t published by the stewards.',
        })
        .catch(() => undefined);
      return;
    }
    // A pending card is not continuing permission to export Slack content. Every source must
    // still be a configured public/internal FAQ channel, and its original reader must still
    // have access. Bypass bridge caches at this final disclosure boundary.
    if (!(await sourcesStillReadable(orch, svc, r))) {
      await sink.notice(
        'denied',
        'A FAQ source is no longer an allowed public, internal channel that the drafter can read. Nothing was published.',
      );
      return;
    }
    const document = {
      question: r.question,
      answer: r.answer,
      sources: r.sources,
      drafter: r.drafterId,
      approver: userId,
      changeId: r.id,
      createdAt: at,
    };
    if (!(await claimFaq(orch, svc, r, 'apply', document, at, sink))) return;
    // Once an external call can begin, the approval is consumed permanently. An ambiguous
    // response or a later storage failure must never turn back into permission to replay it.
    reopen = false;
    const entry = publishEntry(svc, r, userId, at);
    try {
      await orch.deps.stores.record({ ...entry, outcome: 'uncertain' });
    } catch {
      await sink.notice(
        'error',
        'Could not checkpoint the FAQ before publication; nothing was dispatched.',
      );
      return;
    }
    // Claim/checkpoint I/O can outlive Slack permissions. Check again at the external
    // disclosure boundary; this narrows the race without pretending Slack provides a CAS.
    if (!(await sourcesStillReadable(orch, svc, r)) || !(await steward(orch, svc, userId))) {
      await orch.deps.stores.record({ ...entry, outcome: 'rejected' }).catch(() => undefined);
      await sink.notice(
        'denied',
        'FAQ source access or steward authority changed before publication. Nothing was published.',
      );
      return;
    }
    let w: Awaited<ReturnType<FaqWriterPort['create']>>;
    try {
      w = await svc.opts.writer.create(svc.opts.tokens, r.id, document);
    } catch {
      await sink.notice(
        'error',
        'The FAQ publication outcome is uncertain. Inspect Gemini Enterprise before another attempt.',
      );
      return;
    }
    if (!w.ok) {
      orch.observe(teamId, { kind: 'faq', outcome: 'failed', reason: w.code.slice(0, 40) });
      await sink.notice(
        'error',
        `Gemini Enterprise didn’t confirm the FAQ (${w.code}). Inspect it before another attempt.`,
      );
      return;
    }
    const done: FaqRequest = {
      ...r,
      status: 'published',
      decidedBy: userId,
      decidedAt: at,
      documentId: r.id,
    };
    // Preserve the known native outcome, even if one metadata destination is unavailable.
    const checkpoints = await Promise.allSettled([svc.save(done), orch.deps.stores.record(entry)]);
    const checkpointFailed = checkpoints.some((result) => result.status === 'rejected');
    if (checkpointFailed)
      await sink.notice(
        'error',
        'The FAQ was published, but its status could not be fully checkpointed. Do not publish it again; a steward should inspect the document and ledger.',
      );
    orch.observe(teamId, { kind: 'faq', outcome: 'published' });
    if (done.card) await safeFaqCard(orch, svc, done, done.card);
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
  // Removal reduces disclosure; changed channel visibility must not prevent a steward
  // deleting the exported document. Only a final, fresh safeFaqCard check may refresh Slack.
  const r = await svc.get(teamId, id);
  if (!r || r.status === 'removed') {
    await sink.notice('info', 'That FAQ isn’t published.');
    return;
  }
  const entry = await orch.deps.stores.getEntry(teamId, r.id).catch(() => undefined);
  // A publish may have checkpointed its known receipt even when saving the request failed.
  const published =
    r.status === 'published' ||
    (entry?.kind === 'faq' && entry.outcome === 'applied' && !entry.undoneAt);
  if (!published) {
    await sink.notice('info', 'That FAQ isn’t published.');
    return;
  }
  const at = orch.now().toISOString();
  const documentId = r.documentId ?? r.id;
  if (!(await claimFaq(orch, svc, r, 'undo', { documentId }, at, sink))) return;
  // Durable store I/O may outlive the approver's access. Recheck the deleting steward
  // at the provider boundary while retaining the claim if authority was revoked.
  if (!(await steward(orch, svc, userId).catch(() => false))) {
    await sink.notice(
      'denied',
      'Your FAQ steward authority changed before removal. Nothing was removed.',
    );
    return;
  }
  let w: Awaited<ReturnType<FaqWriterPort['remove']>>;
  try {
    w = await svc.opts.writer.remove(svc.opts.tokens, documentId);
  } catch {
    await sink.notice(
      'error',
      'The FAQ removal outcome is uncertain. Inspect Gemini Enterprise before another attempt.',
    );
    return;
  }
  if (!w.ok) {
    await sink.notice(
      'error',
      `Gemini Enterprise didn’t confirm removal (${w.code}). Inspect it before another attempt.`,
    );
    return;
  }
  const done: FaqRequest = {
    ...r,
    status: 'removed',
    decidedBy: userId,
    decidedAt: at,
  };
  const checkpoints = await Promise.allSettled([
    svc.save(done),
    orch.deps.stores.record({
      ...(entry ?? publishEntry(svc, r, r.decidedBy ?? userId, r.decidedAt ?? r.at)),
      undoneAt: at,
      undoneBy: userId,
    }),
  ]);
  if (checkpoints.some((result) => result.status === 'rejected'))
    await sink.notice(
      'error',
      'The FAQ was removed, but its status could not be fully checkpointed. Do not remove it again; inspect the document and ledger.',
    );
  orch.observe(teamId, { kind: 'faq', outcome: 'removed' });
  if (done.card) await safeFaqCard(orch, svc, done, done.card);
}
