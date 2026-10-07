import {
  GRANT_LIMITS,
  TrustKindSchema,
  checkGrant,
  grantTerm,
  licenceBlocksTurn,
  type Automation,
  type DelegationGrant,
  type GrantCheck,
  type TrustKind,
} from '@ge-slack/contracts';
import type { Orchestrator } from './orchestrator.js';
import type { TurnSink } from './ports.js';

/**
 * Delegated runs (ADR-0003 §4): an automation runs as its owner only under a grant that names
 * what it reads and where it posts, for at most 30 days. Every run re-checks the grant, the
 * linked identity, membership of every granted conversation it touches, and the owner's licence.
 */

export function delegationOn(orch: Orchestrator): boolean {
  return Boolean(orch.deps.features?.has('delegation'));
}

/** Full per-run verdict: the pure grant check plus membership and licence. */
export async function delegationVerdict(
  orch: Orchestrator,
  a: Automation,
  touch: { reads: string[]; writes: string[] },
): Promise<GrantCheck> {
  const linked = await orch.deps.identity.getLinked(a.teamId, a.ownerId);
  const pure = checkGrant(a.grant, {
    now: orch.now().getTime(),
    ...(linked ? { subject: linked.subject } : {}),
    reads: touch.reads,
    writes: touch.writes,
  });
  if (!pure.ok) return pure;
  for (const c of new Set([...touch.reads, ...touch.writes])) {
    if (!(await orch.deps.surface.isMember(c, a.ownerId, { fresh: true }).catch(() => false))) {
      return {
        ok: false,
        reason: 'channel-not-granted',
        message: `The owner is no longer a member of <#${c}>.`,
      };
    }
  }
  const lic = orch.deps.features?.has('licences') ? orch.deps.licences : undefined;
  if (lic && linked) {
    const { status } = await lic.status(a.teamId, a.ownerId, linked);
    if (licenceBlocksTurn(status)) {
      return {
        ok: false,
        reason: 'subject-changed',
        message: 'The owner has no Gemini Enterprise licence.',
      };
    }
  }
  return { ok: true };
}

/** The grant a confirmed run-as-me automation gets (its card showed exactly these scopes). */
export async function newGrant(
  orch: Orchestrator,
  a: Pick<Automation, 'id' | 'teamId' | 'ownerId' | 'channelId' | 'destination'>,
  channels?: string[],
): Promise<DelegationGrant | undefined> {
  const linked = await orch.deps.identity.getLinked(a.teamId, a.ownerId);
  if (!linked) return undefined;
  return {
    automationId: a.id,
    teamId: a.teamId,
    ownerId: a.ownerId,
    subject: linked.subject,
    channels: channels ?? [a.channelId],
    destinations: [a.destination ?? a.channelId],
    ...grantTerm(orch.now().getTime()),
  };
}

/** *Renew* in App Home: owner only, same linked identity, still a member of everything granted. */
export async function renewGrant(
  orch: Orchestrator,
  teamId: string,
  automationId: string,
  userId: string,
  sink: TurnSink,
): Promise<void> {
  const port = orch.deps.automations;
  const a = port ? await port.get(teamId, automationId) : undefined;
  if (!port || !a || a.ownerId !== userId || a.runAs !== 'me') {
    await sink.notice('info', 'That automation is gone, or isn’t yours.');
    return;
  }
  const linked = await orch.deps.identity.getLinked(teamId, userId);
  if (!linked || (a.grant && a.grant.subject !== linked.subject)) {
    await sink.notice('denied', 'Connect as the same account you granted this with, then renew.');
    return;
  }
  const channels = a.grant?.channels ?? [a.channelId];
  const destinations = a.grant?.destinations ?? [a.destination ?? a.channelId];
  for (const c of new Set([...channels, ...destinations])) {
    if (!(await orch.deps.surface.isMember(c, userId, { fresh: true }))) {
      await sink.notice(
        'denied',
        `You're no longer a member of <#${c}>, so this can't be renewed.`,
      );
      return;
    }
  }
  const { renewNoticeSentFor: _sent, ...prior } = a.grant ?? ({} as Partial<DelegationGrant>);
  const grant: DelegationGrant = {
    ...prior,
    automationId: a.id,
    teamId,
    ownerId: userId,
    subject: linked.subject,
    channels,
    destinations,
    ...grantTerm(orch.now().getTime()),
  };
  const expiredSuspension = a.suspendedReason?.startsWith('permission to run as you');
  const { suspendedReason: _r, ...rest } = a;
  await port.update({
    ...(expiredSuspension ? { ...rest, enabled: true } : a),
    grant,
  });
  orch.observe(teamId, { kind: 'grant', outcome: 'renewed' });
  await sink.notice(
    'info',
    `Renewed: it runs as you until ${grant.expiresAt.slice(0, 10)}.${expiredSuspension ? ' It’s running again.' : ''}`,
  );
}

/**
 * Cron sweep: run-as-me automations without a grant get a short migration grant (and a DM);
 * grants near expiry get one renewal DM; expired ones suspend the automation.
 */
export async function sweepGrants(orch: Orchestrator, teamId: string): Promise<void> {
  const port = orch.deps.automations;
  if (!port || !delegationOn(orch)) return;
  const now = orch.now().getTime();
  for (const a of await port.list(teamId)) {
    if (a.runAs !== 'me') continue;
    if (!a.grant) {
      if (!a.enabled) continue;
      const g = await newGrant(orch, a);
      if (!g) continue;
      await port.update({ ...a, grant: { ...g, ...grantTerm(now, GRANT_LIMITS.migrationDays) } });
      orch.observe(teamId, { kind: 'grant', outcome: 'migrated' });
      await orch.deps.surface
        .notifyUser(a.ownerId, {
          text: `✦ Your automation ${a.id} runs as you. That now needs a permission you renew every ${GRANT_LIMITS.termDays} days — renew it in the Gemini app's Home tab within ${GRANT_LIMITS.migrationDays} days, or it pauses.`,
        })
        .catch(() => undefined);
      continue;
    }
    const ends = Date.parse(a.grant.expiresAt);
    if (now >= ends) {
      if (a.enabled) {
        await port.update({
          ...a,
          enabled: false,
          suspendedReason: 'permission to run as you expired',
        });
        orch.observe(teamId, { kind: 'grant', outcome: 'expired' });
        await orch.deps.surface
          .notifyUser(a.ownerId, {
            text: `✦ Automation ${a.id} paused: its permission to run as you expired. Renew it in the Gemini app's Home tab.`,
          })
          .catch(() => undefined);
      }
      continue;
    }
    if (
      ends - now <= GRANT_LIMITS.renewNoticeDays * 86_400_000 &&
      a.grant.renewNoticeSentFor !== a.grant.expiresAt
    ) {
      await port.update({ ...a, grant: { ...a.grant, renewNoticeSentFor: a.grant.expiresAt } });
      await orch.deps.surface
        .notifyUser(a.ownerId, {
          text: `✦ Automation ${a.id} can run as you until ${a.grant.expiresAt.slice(0, 10)}. Renew it in the Gemini app's Home tab to keep it running.`,
        })
        .catch(() => undefined);
    }
  }
}

// ------------------------------------------------------------------ §2 trust levels

const trustKey = (teamId: string, userId: string) => `trust/${teamId}/${userId}`;

export async function trustFor(
  orch: Orchestrator,
  teamId: string,
  userId: string,
): Promise<Set<TrustKind>> {
  if (!orch.deps.features?.has('trust-levels')) return new Set();
  const raw = await orch.deps.stores.kv.get<string[]>(trustKey(teamId, userId));
  return new Set(
    (raw ?? []).flatMap((k) => (TrustKindSchema.safeParse(k).success ? [k as TrustKind] : [])),
  );
}

export async function setTrust(
  orch: Orchestrator,
  teamId: string,
  userId: string,
  kinds: string[],
): Promise<void> {
  const valid = kinds.filter((k) => TrustKindSchema.safeParse(k).success);
  if (valid.length) await orch.deps.stores.kv.set(trustKey(teamId, userId), valid);
  else await orch.deps.stores.kv.delete(trustKey(teamId, userId));
  orch.observe(teamId, { kind: 'grant', outcome: valid.length ? 'trust-on' : 'trust-off' });
}
