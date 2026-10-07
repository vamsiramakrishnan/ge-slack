import { z } from 'zod';

/**
 * ADR-0003 §2–§5: delegated runs, trust levels, proactive suggestions and thread → FAQ. Pure
 * shapes and policy only; the runtime enforces them.
 */

// ------------------------------------------------------------------ §4 delegation grants

const Conversation = z.string().regex(/^[CGD][A-Z0-9]{2,}$/);

/**
 * Consent for one automation to run as its owner while they're away. Created by confirming the
 * automation card (which shows exactly these scopes), at most 30 days, renewed with one click.
 */
export const DelegationGrantSchema = z.object({
  automationId: z.string(),
  teamId: z.string(),
  ownerId: z.string(),
  /** The linked IdP subject at grant time: a re-link as anyone else voids the grant. */
  subject: z.string().min(1),
  /** Conversations the run may read. */
  channels: z.array(Conversation).min(1).max(10),
  /** Conversations it may post to. */
  destinations: z.array(Conversation).min(1).max(5),
  /** Data stores it may ground on, resolved when consent was given (an admin's later change to a
   * channel's @unit doesn't widen it). */
  dataStores: z.array(z.string()).max(20).default([]),
  grantedAt: z.string(),
  expiresAt: z.string(),
  /** A renewal DM was sent for this expiry (one per term). */
  renewNoticeSentFor: z.string().optional(),
});
export type DelegationGrant = z.infer<typeof DelegationGrantSchema>;

export const GRANT_LIMITS = {
  termDays: 30,
  renewNoticeDays: 3,
  /** Run-as-me automations created before grants existed get this long to be renewed. */
  migrationDays: 7,
} as const;

export type GrantCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'no-grant'
        | 'expired'
        | 'subject-changed'
        | 'channel-not-granted'
        | 'destination-not-granted';
      message: string;
    };

/** Pure part of the per-run grant check (membership and licence are checked by the runtime). */
export function checkGrant(
  g: DelegationGrant | undefined,
  ctx: {
    now: number;
    subject?: string;
    reads: string[];
    writes: string[];
    /** The automation this run belongs to: the grant must be its own. */
    automation?: { id: string; ownerId: string; teamId: string };
    dataStores?: string[];
  },
): GrantCheck {
  if (
    g &&
    ctx.automation &&
    (g.automationId !== ctx.automation.id ||
      g.ownerId !== ctx.automation.ownerId ||
      g.teamId !== ctx.automation.teamId)
  ) {
    return {
      ok: false,
      reason: 'no-grant',
      message: 'This automation’s permission doesn’t match it.',
    };
  }
  if (!g) {
    return {
      ok: false,
      reason: 'no-grant',
      message: 'This automation has no permission to run as its owner. Renew it from App Home.',
    };
  }
  if (ctx.now >= Date.parse(g.expiresAt)) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Permission to run as its owner expired. Renew it from App Home.',
    };
  }
  if (!ctx.subject || ctx.subject !== g.subject) {
    return {
      ok: false,
      reason: 'subject-changed',
      message: 'The owner disconnected or connected a different account since granting this.',
    };
  }
  const bad = ctx.reads.find((c) => !g.channels.includes(c));
  if (bad) {
    return {
      ok: false,
      reason: 'channel-not-granted',
      message: `This automation may not read <#${bad}> as its owner.`,
    };
  }
  const badStore = (ctx.dataStores ?? []).find((d) => !(g.dataStores ?? []).includes(d));
  if (badStore) {
    return {
      ok: false,
      reason: 'channel-not-granted',
      message: 'This automation would use sources it wasn’t granted. Renew it to review them.',
    };
  }
  const badDest = ctx.writes.find((c) => !g.destinations.includes(c));
  if (badDest) {
    return {
      ok: false,
      reason: 'destination-not-granted',
      message: `This automation may not post to <#${badDest}> as its owner.`,
    };
  }
  return { ok: true };
}

export function grantTerm(now: number, days: number = GRANT_LIMITS.termDays) {
  return {
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 86_400_000).toISOString(),
  };
}

// ------------------------------------------------------------------ §2 trust levels

/**
 * Changes whose blast radius is only the person themselves, which they may opt in to apply
 * without a per-change click. Everything that reaches anyone else keeps approval.
 */
export const TrustKindSchema = z.enum(['dm-reply', 'remind-self']);
export type TrustKind = z.infer<typeof TrustKindSchema>;

export const TRUST_LABELS: Record<TrustKind, string> = {
  'dm-reply': 'Replies in my Gemini DM',
  'remind-self': 'Reminders to myself',
};

// ------------------------------------------------------------------ §3 suggestions

export const SUGGEST_LIMITS = {
  /** Wait this long for a human answer before suggesting one. */
  delayMs: 10 * 60_000,
  perChannelPerDay: 20,
  perAskerPerDay: 5,
  minChars: 12,
  maxChars: 2000,
  /** A suggestion can be posted for this long. */
  ttlMs: 24 * 3_600_000,
} as const;

/** Does a top-level message read like a question someone wants answered? (cheap, conservative) */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < SUGGEST_LIMITS.minChars || t.length > SUGGEST_LIMITS.maxChars) return false;
  if (t.startsWith('/')) return false;
  if (/<!(channel|here|everyone)>/.test(t)) return false;
  return (
    /\?\s*$/.test(t) ||
    /\?\s/.test(t) ||
    /^(who|what|when|where|why|how|which|can|could|does|do|is|are|should|anyone|has anyone)\b/i.test(
      t,
    )
  );
}

// ------------------------------------------------------------------ §5 thread → FAQ

export const FAQ_LIMITS = {
  questionChars: 300,
  /** Small enough that the stewards' card always shows every character that gets published. */
  answerChars: 3000,
  sources: 10,
  requestRetainMs: 30 * 86_400_000,
} as const;

export type FaqStatus = 'open' | 'published' | 'rejected' | 'removed' | 'failed';

export interface FaqRequest {
  id: string;
  teamId: string;
  drafterId: string;
  question: string;
  answer: string;
  /** Slack permalinks the answer came from (public channels only). */
  sources: string[];
  channel: string;
  /** Every conversation the answer read (all public FAQ channels), shown to stewards. */
  readChannels?: string[];
  status: FaqStatus;
  at: string;
  decidedBy?: string;
  decidedAt?: string;
  /** The data store document, once published. */
  documentId?: string;
  card?: { channel: string; ts: string };
}

/** Remove everything that would name or ping a Slack identity in a document others will read. */
export function faqClean(text: string, max: number): string {
  return (
    text
      .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, 'a teammate')
      .replace(/<#[CG][A-Z0-9]+(?:\|([^>]*))?>/g, (_m, name: string | undefined) =>
        name ? `#${name}` : 'a channel',
      )
      // Links keep their label (or bare URL); every other Slack token (broadcasts, user groups,
      // mailto) goes.
      .replace(/<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) =>
        label ? `${label} (${url})` : url,
      )
      .replace(/<[^>]*>/g, '')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]')
      .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? c : ''))
      .trim()
      .slice(0, max)
  );
}
