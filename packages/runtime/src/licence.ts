import { randomBytes } from 'node:crypto';
import {
  LICENCE_LIMITS,
  isUnattended,
  licenceBlocksTurn,
  licenceRequestable,
  type Invocation,
  type LicencePrincipalField,
  type LicenceRequest,
  type LicenceStatus,
  type Origin,
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
  ): Promise<{ status: LicenceStatus; reason?: string }>;
  assign(
    tokens: TokenSource,
    principal: string,
    licenseConfig: string,
  ): Promise<{ ok: true } | { ok: false; code: string }>;
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
  now?: () => number;
}

type Cached = { status: LicenceStatus; reason?: string; at: number };

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

  principalOf(linked: { email: string; subject: string }): string {
    return this.opts.principalField === 'subject' ? linked.subject : linked.email;
  }

  async status(
    teamId: string,
    userId: string,
    linked: { email: string; subject: string },
    opts: { fresh?: boolean } = {},
  ): Promise<{ status: LicenceStatus; reason?: string }> {
    const key = `licence/${teamId}/${userId}`;
    const principal = this.principalOf(linked);
    if (!opts.fresh) {
      const hit = await this.kv.get<Cached & { principal: string }>(key);
      if (hit && hit.principal === principal)
        return { status: hit.status, ...(hit.reason ? { reason: hit.reason } : {}) };
    }
    const r = await this.opts.directory
      .lookup(this.opts.tokens, principal)
      .catch(() => ({ status: 'unknown' as const, reason: 'lookup-failed' }));
    const ttl =
      r.status === 'assigned' ? LICENCE_LIMITS.assignedTtlMs : LICENCE_LIMITS.missingTtlMs;
    await this.kv.set(key, { ...r, principal, at: this.now() }, { ttlMs: ttl });
    return r;
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

  assign(principal: string) {
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
  const prior = await svc.getRequest(origin.teamId, origin.userId);
  const now = Date.now();
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
  const req: LicenceRequest = {
    id: randomBytes(8).toString('hex'),
    teamId: origin.teamId,
    requesterId: origin.userId,
    email: linked.email,
    status: 'open',
    at: new Date(now).toISOString(),
  };
  const card = await orch.deps.surface
    .licenceRequestCard(svc.requestsChannel, requestView(svc, req))
    .catch(() => undefined);
  if (!card) {
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
 * never the requester, and only once. Approving assigns the licence to the requester's *current*
 * linked identity — refused if it changed since they asked.
 */
export async function decideLicence(
  orch: Orchestrator,
  teamId: string,
  requesterId: string,
  requestId: string,
  approverId: string,
  decision: 'approve' | 'decline',
  sink: TurnSink,
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
  if (!allowed || !(await orch.deps.surface.isMember(svc.requestsChannel, approverId))) {
    await sink.notice('denied', 'Only workspace admins and named licence approvers can decide.');
    return;
  }
  const req = await svc.getRequest(teamId, requesterId);
  if (!req || req.id !== requestId || req.status !== 'open') {
    await sink.notice('info', 'Someone already decided that request.');
    return;
  }
  const lock = await svc.takeLock(teamId, requesterId);
  if (lock !== requestId) {
    await sink.notice('info', 'Someone already decided that request.');
    return;
  }
  const decided = (status: LicenceRequest['status']): LicenceRequest => ({
    ...req,
    status,
    decidedBy: approverId,
    decidedAt: new Date().toISOString(),
  });
  let final: LicenceRequest;
  let toRequester: string;
  if (decision === 'decline') {
    final = decided('declined');
    toRequester =
      '✦ Your Gemini Enterprise licence request was declined. Talk to your admin if you need it.';
  } else if (svc.canAssign) {
    const linked = await orch.deps.identity.getLinked(teamId, requesterId);
    if (!linked || linked.email !== req.email) {
      final = decided('declined');
      await svc.saveRequest(final);
      await updateCard(orch, svc, final);
      await sink.notice(
        'error',
        'The requester disconnected or linked a different account since asking. Nothing was assigned; they can request again.',
      );
      return;
    }
    const r = await svc.assign(svc.principalOf(linked));
    if (!r.ok) {
      await svc.openLock(req); // still open: someone can try again
      await sink.notice(
        'error',
        `Gemini Enterprise didn’t assign the licence (${r.code}). Nothing changed; try again, or assign it in the Gemini Enterprise console.`,
      );
      return;
    }
    await svc.forget(teamId, requesterId);
    final = decided('assigned');
    toRequester = '✅ You have a Gemini Enterprise licence now. Run your request again.';
  } else {
    final = decided('approved');
    toRequester =
      '✅ Your Gemini Enterprise licence request was approved. You’ll be able to use Gemini once an admin assigns it.';
  }
  await svc.saveRequest(final);
  orch.observe(teamId, { kind: 'licence', outcome: final.status });
  await updateCard(orch, svc, final);
  await orch.deps.surface.notifyUser(requesterId, { text: toRequester }).catch(() => undefined);
  if (final.status === 'approved') {
    await sink.notice(
      'info',
      `Approved. Assign a licence to ${req.email} in the Gemini Enterprise console (Manage users → licences), then they can use it.`,
    );
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
