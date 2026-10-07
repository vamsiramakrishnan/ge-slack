import { randomBytes } from 'node:crypto';
import {
  LICENCE_LIMITS,
  isUnattended,
  licenceBlocksTurn,
  licenceRequestable,
  type Invocation,
  type LicenceAuditEntry,
  type LicencePrincipalField,
  type LicenceRequest,
  type LicenceStatus,
  type Origin,
  samePrincipal,
} from '@ge-slack/contracts';
import type { TokenSource } from '@ge-slack/gemini-client';
import type { KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from './orchestrator.js';
import type { TurnSink } from './ports.js';

/**
 * Licence-aware onboarding (EXPERIENCE §11, ADR-0003 §1). Gemini Enterprise decides who is
 * licensed; the bot reads that through an admin-plane identity so a person learns it *before* a
 * request fails, and can ask for a licence in one click. A workspace admin (or a named approver)
 * decides; with `GE_LICENCE_CONFIG` set, approving assigns the licence directly.
 */

export interface LicenceDirectoryPort {
  lookup(
    tokens: TokenSource,
    principal: string,
    field?: LicencePrincipalField,
  ): Promise<{ status: LicenceStatus; reason?: string; principal?: string }>;
  assign(
    tokens: TokenSource,
    principal: string,
    licenseConfig: string,
  ): Promise<{ ok: true } | { ok: false; code: string; pending?: boolean }>;
}

export interface LicenceOptions {
  directory: LicenceDirectoryPort;
  /** Admin-plane identity that reads (and, with `licenseConfig`, assigns) user licences. */
  tokens: TokenSource;
  /** Which linked-identity field the user store keys people by (default `email`). */
  principalField?: LicencePrincipalField;
  /** Licence config assigned on approval. Unset: approval tells the requester an admin will assign. */
  licenseConfig?: string;
  /** Channel where requests are posted for approval. Unset: people are told to ask their admin. */
  requestsChannel?: string;
  /** Slack user ids allowed to decide besides workspace admins/owners. */
  approvers?: readonly string[];
  /** The admin-plane identity's name, recorded in the audit trail of each assignment. */
  adminIdentity?: string;
  now?: () => number;
}

type Cached = { status: LicenceStatus; reason?: string; found?: string; at: number };

/** Fresh lookups (Request clicks, 403s, diag) reuse a lookup this recent instead (quota). */
const FRESH_MIN_MS = 30_000;

/** Status cache, open requests and the one-decision lock, all in the shared store. */
export class LicenceService {
  readonly approvers: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(
    private readonly kv: KeyValueStore,
    readonly opts: LicenceOptions,
  ) {
    this.approvers = new Set(opts.approvers ?? []);
    this.now = opts.now ?? Date.now;
  }

  get canAssign(): boolean {
    return Boolean(this.opts.licenseConfig);
  }
  get requestsChannel(): string | undefined {
    return this.opts.requestsChannel;
  }

  get field(): LicencePrincipalField {
    return this.opts.principalField ?? 'email';
  }

  principalOf(linked: { email: string; subject: string }): string {
    return this.field === 'subject' ? linked.subject : linked.email;
  }

  /**
   * The person's licence state. `found` is the user store's own spelling of their principal (an
   * assignment goes to exactly that row, never a new one that differs only in case).
   */
  async status(
    teamId: string,
    userId: string,
    linked: { email: string; subject: string },
    /** `force`: always ask the directory (approval-time safety checks; never throttled). */
    opts: { fresh?: boolean; force?: boolean } = {},
  ): Promise<{ status: LicenceStatus; reason?: string; found?: string }> {
    const key = `licence/${teamId}/${userId}`;
    const principal = this.principalOf(linked);
    const hit = opts.force ? undefined : await this.kv.get<Cached & { principal: string }>(key);
    if (hit && hit.principal === principal && (!opts.fresh || this.now() - hit.at < FRESH_MIN_MS)) {
      return {
        status: hit.status,
        ...(hit.reason ? { reason: hit.reason } : {}),
        ...(hit.found ? { found: hit.found } : {}),
      };
    }
    const r = await this.opts.directory
      .lookup(this.opts.tokens, principal, this.field)
      .catch(() => ({ status: 'unknown' as const, reason: 'lookup-failed' }));
    const out = {
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...('principal' in r && r.principal ? { found: r.principal } : {}),
    };
    const ttl =
      r.status === 'assigned' ? LICENCE_LIMITS.assignedTtlMs : LICENCE_LIMITS.missingTtlMs;
    await this.kv.set(key, { ...out, principal, at: this.now() }, { ttlMs: ttl });
    return out;
  }

  /** The cached state only (no lookup): used to keep blocked people off the service path. */
  async cached(teamId: string, userId: string): Promise<LicenceStatus | undefined> {
    return (await this.kv.get<Cached>(`licence/${teamId}/${userId}`))?.status;
  }

  audit(e: LicenceAuditEntry) {
    return this.kv.set(`licaudit/${e.teamId}/${e.at}/${e.requestId}/${e.outcome}`, e);
  }
  async auditSince(teamId: string, sinceMs: number): Promise<LicenceAuditEntry[]> {
    const rows = await this.kv.list<LicenceAuditEntry>(`licaudit/${teamId}/`);
    return rows
      .map((r) => r.value)
      .filter((e) => Date.parse(e.at) >= sinceMs)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  forget(teamId: string, userId: string): Promise<void> {
    return this.kv.delete(`licence/${teamId}/${userId}`);
  }

  getRequest(teamId: string, userId: string) {
    return this.kv.get<LicenceRequest>(`licreq/${teamId}/${userId}`);
  }
  saveRequest(r: LicenceRequest) {
    return this.kv.set(`licreq/${r.teamId}/${r.requesterId}`, r, {
      ttlMs: LICENCE_LIMITS.requestRetainMs,
    });
  }
  /** One decision per request, across instances: the lock is taken atomically. */
  openLock(r: LicenceRequest) {
    return this.kv.set(`licopen/${r.teamId}/${r.requesterId}`, r.id, {
      ttlMs: LICENCE_LIMITS.requestRetainMs,
    });
  }
  takeLock(teamId: string, requesterId: string) {
    return this.kv.take<string>(`licopen/${teamId}/${requesterId}`);
  }

  get licenseConfig(): string | undefined {
    return this.opts.licenseConfig;
  }
  get adminIdentity(): string | undefined {
    return this.opts.adminIdentity;
  }

  assign(
    principal: string,
  ): Promise<{ ok: true } | { ok: false; code: string; pending?: boolean }> {
    if (!this.opts.licenseConfig)
      return Promise.resolve({ ok: false as const, code: 'not_configured' });
    return this.opts.directory.assign(this.opts.tokens, principal, this.opts.licenseConfig);
  }
}

function enabled(orch: Orchestrator): LicenceService | undefined {
  return orch.deps.features?.has('licences') ? orch.deps.licences : undefined;
}

/**
 * Before a user-principal turn: stop early only when the user store *knows* there's no licence,
 * and say what to do. Unknown never blocks — Gemini Enterprise has the final word.
 * Returns false when the turn must not continue.
 */
export async function licenceGate(
  orch: Orchestrator,
  inv: Invocation,
  origin: Origin,
  sink: TurnSink,
  offerService: boolean,
): Promise<boolean> {
  const svc = enabled(orch);
  if (!svc) return true;
  const linked = await orch.deps.identity.getLinked(origin.teamId, origin.userId);
  if (!linked) return true;
  const { status } = await svc.status(origin.teamId, origin.userId, linked);
  if (!licenceBlocksTurn(status)) return true;
  await showLicenceCard(orch, inv, origin, sink, status, offerService);
  return false;
}

/**
 * A person an admin blocked in Gemini Enterprise doesn't get answers through the Gemini service
 * either (the service would otherwise route around the block). Uses the cached state only.
 * Returns false when the turn must not continue.
 */
export async function licenceServiceGuard(
  orch: Orchestrator,
  origin: Origin,
  sink: TurnSink,
): Promise<boolean> {
  const svc = enabled(orch);
  if (!svc) return true;
  if ((await svc.cached(origin.teamId, origin.userId)) !== 'blocked') return true;
  await sink.notice(
    'denied',
    'Your Gemini Enterprise access is blocked by an admin, so Gemini can’t answer for you — as you or as the Gemini service.',
  );
  return false;
}

/**
 * A 403 from Gemini Enterprise on a user turn: look again (the cached status may be stale) and,
 * if the person has no licence, show the licence card instead of a bare error. Returns true when
 * it rendered something.
 */
export async function licenceOnForbidden(
  orch: Orchestrator,
  inv: Invocation,
  origin: Origin,
  sink: TurnSink,
  offerService: boolean,
): Promise<boolean> {
  const svc = enabled(orch);
  if (!svc) return false;
  const linked = await orch.deps.identity.getLinked(origin.teamId, origin.userId);
  if (!linked) return false;
  const { status } = await svc.status(origin.teamId, origin.userId, linked, { fresh: true });
  if (!licenceBlocksTurn(status)) return false;
  await showLicenceCard(orch, inv, origin, sink, status, offerService);
  return true;
}

async function showLicenceCard(
  orch: Orchestrator,
  inv: Invocation,
  origin: Origin,
  sink: TurnSink,
  status: LicenceStatus,
  offerService: boolean,
): Promise<void> {
  const svc = orch.deps.licences!;
  // An admin blocked this person: the bot must not route them around it via the service (M1).
  offerService = offerService && status !== 'blocked';
  orch.observe(origin.teamId, { kind: 'licence', outcome: 'missing' });
  if (isUnattended(origin)) {
    // Nobody is there to click: the owner hears about it through the unattended sink.
    await sink.notice(
      'denied',
      'This automation runs as its owner, who has no Gemini Enterprise licence. Ask an admin for one, or switch the automation to the Gemini service.',
    );
    return;
  }
  const pending = await svc.getRequest(origin.teamId, origin.userId);
  const open = pending?.status === 'open' ? pending : undefined;
  let resumeId: string | undefined;
  if (offerService) {
    resumeId = randomBytes(10).toString('hex');
    await orch.deps.stores.saveResume(resumeId, { origin, invocation: inv });
  }
  const catalog = offerService ? await orch.deps.config.catalog(origin.teamId) : [];
  const policy = offerService
    ? await orch.deps.config.channelPolicy(origin.teamId, origin.channelId ?? '')
    : undefined;
  await sink.licence({
    status: status === 'blocked' ? 'blocked' : 'unlicensed',
    message:
      status === 'blocked'
        ? 'Your Gemini Enterprise access is blocked by an admin, so Gemini can’t answer as you.'
        : 'You’re connected, but you don’t have a Gemini Enterprise licence yet, so Gemini can’t answer as you.',
    requestable: licenceRequestable(status) && Boolean(svc.requestsChannel),
    ...(open ? { requestedAt: open.at } : {}),
    offerService,
    serviceSources: catalog
      .filter((c) => c.serviceAllowed && (policy?.serviceGrounds ?? []).includes(c.alias))
      .map((c) => c.title),
    ...(resumeId ? { resumeId } : {}),
  });
}

/** The Request button (licence card or App Home): post one request for an admin to decide. */
export async function requestLicence(
  orch: Orchestrator,
  origin: Origin,
  sink: TurnSink,
): Promise<void> {
  const svc = enabled(orch);
  if (!svc) {
    await sink.notice('info', 'Licence requests are switched off for this workspace.');
    return;
  }
  const linked = await orch.deps.identity.getLinked(origin.teamId, origin.userId);
  if (!linked) {
    await sink.notice(
      'info',
      'Connect your account first (`/gemini connect`), then request a licence.',
    );
    return;
  }
  if (!svc.requestsChannel) {
    await sink.notice(
      'info',
      'Your workspace takes licence requests outside Slack — ask your Gemini Enterprise admin.',
    );
    return;
  }
  if (await orch.deps.surface.isGuest(origin.userId)) {
    await sink.notice(
      'denied',
      'Guests and external members can’t request a licence here — ask the admin who invited you.',
    );
    return;
  }
  // The card names the person and their email: only ever in a private, internal channel (M4).
  const where = await orch.deps.surface
    .conversationInfo(svc.requestsChannel)
    .catch(() => undefined);
  if (!where || where.isExtShared || !where.isPrivate) {
    await sink.notice(
      'error',
      'Licence requests aren’t set up correctly here (the admins’ channel must be private and internal). Ask your Gemini Enterprise admin.',
    );
    return;
  }
  const prior = await svc.getRequest(origin.teamId, origin.userId);
  const now = Date.now();
  // Open or recently decided requests are answered before any lookup (quota, L9).
  if (prior?.status === 'open') {
    await sink.notice(
      'info',
      `You asked on ${prior.at.slice(0, 10)}; admins have it. You’ll get a DM when someone decides.`,
    );
    return;
  }
  if (
    prior &&
    prior.decidedAt &&
    now - Date.parse(prior.decidedAt) < LICENCE_LIMITS.requestCooldownMs &&
    (prior.status === 'declined' || prior.status === 'approved')
  ) {
    await sink.notice(
      'info',
      prior.status === 'approved'
        ? 'Your request was approved; an admin still has to assign the licence. Ask them if it’s taking a while.'
        : 'Your last request was declined recently. Talk to your admin before asking again.',
    );
    return;
  }
  const { status } = await svc.status(origin.teamId, origin.userId, linked, { fresh: true });
  if (status === 'assigned') {
    await sink.notice(
      'info',
      'You already have a Gemini Enterprise licence — try your request again.',
    );
    return;
  }
  if (!licenceRequestable(status)) {
    await sink.notice(
      'info',
      'An admin has blocked Gemini Enterprise access for your account. Ask them directly.',
    );
    return;
  }
  const req: LicenceRequest = {
    id: randomBytes(8).toString('hex'),
    teamId: origin.teamId,
    requesterId: origin.userId,
    email: linked.email,
    principal: svc.principalOf(linked),
    status: 'open',
    at: new Date(now).toISOString(),
  };
  // Saved before the card is posted, so a double click finds it open and posts nothing (L3).
  await svc.saveRequest(req);
  const card = await orch.deps.surface
    .licenceRequestCard(svc.requestsChannel, requestView(svc, req))
    .catch(() => undefined);
  if (!card) {
    await svc.saveRequest({ ...req, status: 'void' });
    await sink.notice(
      'error',
      'Couldn’t reach the admins’ channel. Try again, or ask your admin directly.',
    );
    return;
  }
  const saved = { ...req, card };
  await svc.saveRequest(saved);
  await svc.openLock(saved);
  orch.observe(origin.teamId, { kind: 'licence', outcome: 'requested' });
  await sink.notice(
    'info',
    '📨 Requested. Your admins have it, and you’ll get a DM when someone decides.',
  );
}

export function requestView(svc: LicenceService, r: LicenceRequest) {
  return {
    requestId: r.id,
    requesterId: r.requesterId,
    email: r.email,
    status: r.status,
    at: r.at,
    assignOnApprove: svc.canAssign,
    ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
  };
}

/**
 * Approve or decline from the admins' channel. Only a workspace admin/owner or a named approver,
 * never the requester, only on the request's own card, and only once. Approving re-checks the
 * user store and assigns to the requester's *current* linked principal — refused if it changed
 * since they asked, or if an admin blocked them meanwhile. Every outcome is audited.
 */
export async function decideLicence(
  orch: Orchestrator,
  teamId: string,
  requesterId: string,
  requestId: string,
  approverId: string,
  decision: 'approve' | 'decline',
  sink: TurnSink,
  clicked?: { channel?: string; ts?: string },
): Promise<void> {
  const svc = enabled(orch);
  if (!svc || !svc.requestsChannel) {
    await sink.notice('info', 'Licence requests are switched off for this workspace.');
    return;
  }
  if (approverId === requesterId) {
    await sink.notice('denied', 'You can’t decide your own licence request.');
    return;
  }
  const allowed =
    svc.approvers.has(approverId) || (await orch.deps.surface.isWorkspaceAdmin(approverId));
  // Membership is checked fresh: someone just removed from the channel can't still decide (L7).
  if (
    !allowed ||
    !(await orch.deps.surface.isMember(svc.requestsChannel, approverId, { fresh: true }))
  ) {
    await sink.notice('denied', 'Only workspace admins and named licence approvers can decide.');
    return;
  }
  const req = await svc.getRequest(teamId, requesterId);
  if (!req || req.id !== requestId || req.status !== 'open') {
    await sink.notice('info', 'Someone already decided that request.');
    return;
  }
  // Decisions come from the request's own card (L6).
  if (clicked && (clicked.channel !== req.card?.channel || clicked.ts !== req.card?.ts)) {
    await sink.notice('denied', 'Decide licence requests from their card in the admins’ channel.');
    return;
  }
  const lock = await svc.takeLock(teamId, requesterId);
  if (lock !== requestId) {
    await sink.notice('info', 'Someone already decided that request.');
    return;
  }
  const at = () => new Date().toISOString();
  const audit = (outcome: LicenceAuditEntry['outcome'], extra: Partial<LicenceAuditEntry> = {}) =>
    svc.audit({
      at: at(),
      teamId,
      requestId,
      requesterId,
      deciderId: approverId,
      outcome,
      principal: req.principal,
      ...extra,
    });
  let reopen = true;
  try {
    const finish = async (
      status: LicenceRequest['status'],
      toRequester: string | undefined,
    ): Promise<LicenceRequest> => {
      const final: LicenceRequest = {
        ...req,
        status,
        ...(status === 'void' ? {} : { decidedBy: approverId }),
        decidedAt: at(),
      };
      await svc.saveRequest(final);
      reopen = false;
      orch.observe(teamId, { kind: 'licence', outcome: status });
      await updateCard(orch, svc, final);
      if (toRequester) {
        await orch.deps.surface
          .notifyUser(requesterId, { text: toRequester })
          .catch(() => undefined);
      }
      return final;
    };

    if (decision === 'decline') {
      await audit('declined');
      await finish(
        'declined',
        '✦ Your Gemini Enterprise licence request was declined. Talk to your admin if you need it.',
      );
      return;
    }

    // Approving: the requester must still be the identity that asked (L2).
    const linked = await orch.deps.identity.getLinked(teamId, requesterId);
    if (!linked || !samePrincipal(svc.field, svc.principalOf(linked), req.principal)) {
      await audit('void');
      await finish('void', undefined);
      await sink.notice(
        'error',
        'The requester disconnected or linked a different account since asking. Nothing was assigned; they can request again.',
      );
      return;
    }
    // …and the user store must still allow it: never override a block made meanwhile (M2).
    const now = await svc.status(teamId, requesterId, linked, { force: true });
    if (now.status === 'blocked') {
      await audit('refused-blocked');
      await finish('void', undefined);
      await sink.notice(
        'error',
        'An admin has since blocked this person in Gemini Enterprise. Nothing was assigned.',
      );
      return;
    }
    if (now.status === 'assigned') {
      await audit('assigned', { code: 'already-assigned' });
      await finish(
        'assigned',
        '✅ You have a Gemini Enterprise licence now. Run your request again.',
      );
      return;
    }
    if (!svc.canAssign) {
      await audit('approved');
      await finish(
        'approved',
        '✅ Your Gemini Enterprise licence request was approved. You’ll be able to use Gemini once an admin assigns it.',
      );
      await sink.notice(
        'info',
        `Approved. Assign a licence to ${req.email} in the Gemini Enterprise console (Manage users → licences), then they can use it.`,
      );
      return;
    }
    // Assign to the row the user store already has, in its own spelling (L1).
    const target = now.found ?? req.principal;
    const r = await svc.assign(target);
    const assignAudit = {
      principal: target,
      ...(svc.licenseConfig ? { licenseConfig: svc.licenseConfig } : {}),
      ...(svc.adminIdentity ? { adminIdentity: svc.adminIdentity } : {}),
    };
    if (!r.ok) {
      // `reopen` stays true either way: someone can try again (the same assignment is idempotent).
      await audit(r.pending ? 'assign-pending' : 'assign-failed', { ...assignAudit, code: r.code });
      await sink.notice(
        'error',
        r.pending
          ? 'Gemini Enterprise accepted the assignment but hasn’t finished yet. Check the console in a minute; approving again is safe.'
          : `Gemini Enterprise didn’t assign the licence (${r.code}). Try again, or assign it in the Gemini Enterprise console.`,
      );
      return;
    }
    await audit('assigned', assignAudit);
    await svc.forget(teamId, requesterId);
    await finish(
      'assigned',
      '✅ You have a Gemini Enterprise licence now. Run your request again.',
    );
  } finally {
    // Anything that didn't reach a final state leaves the request decidable again (L4).
    if (reopen) await svc.openLock(req).catch(() => undefined);
  }
}

async function updateCard(orch: Orchestrator, svc: LicenceService, r: LicenceRequest) {
  if (!r.card || !svc.requestsChannel) return;
  await orch.deps.surface
    .licenceRequestCard(r.card.channel, requestView(svc, r), r.card.ts)
    .catch(() => undefined);
}

/** The person's licence for `/gemini diag` and App Home: one line, and whether Request applies. */
export async function licenceSummary(
  orch: Orchestrator,
  teamId: string,
  userId: string,
  opts: { fresh?: boolean } = {},
): Promise<{ line: string; requestable: boolean; status: LicenceStatus } | undefined> {
  const svc = enabled(orch);
  if (!svc) return undefined;
  const linked = await orch.deps.identity.getLinked(teamId, userId);
  if (!linked) return undefined;
  const { status, reason } = await svc.status(teamId, userId, linked, opts);
  const req = await svc.getRequest(teamId, userId);
  const open = req?.status === 'open';
  const requestable = status === 'unlicensed' && Boolean(svc.requestsChannel) && !open;
  const asked = open ? ` · requested ${req.at.slice(0, 10)}` : '';
  const line = (() => {
    switch (status) {
      case 'assigned':
        return '✅ *Licence*  Gemini Enterprise licence assigned';
      case 'unlicensed':
        return `⚠️ *Licence*  no Gemini Enterprise licence${asked}`;
      case 'blocked':
        return '🚫 *Licence*  Gemini Enterprise access blocked by an admin';
      default:
        return reason === 'not-found'
          ? '❔ *Licence*  not in the Gemini Enterprise user store yet (first use may register you)'
          : `❔ *Licence*  couldn’t check (${reason ?? 'unknown'})`;
    }
  })();
  return { line, requestable, status };
}
