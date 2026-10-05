import { z } from 'zod';
import type { RunAs } from './invocation.js';

export const IdpKindSchema = z.enum(['oidc', 'google']);
export type IdpKind = z.infer<typeof IdpKindSchema>;

/** Exactly one principal per turn. Stamped into provenance and shown in every identity footer. */
export const PrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    teamId: z.string(),
    slackUserId: z.string(),
    /** IdP subject (`sub`) — the federated identity Google sees. */
    subject: z.string(),
    email: z.string().email(),
    provider: IdpKindSchema,
  }),
  z.object({
    kind: z.literal('service'),
    /** The GE-licensed service account email. */
    serviceAccount: z.string().regex(/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/),
    /** The Slack user who caused this run — attribution, never authority. */
    onBehalfOf: z.object({ teamId: z.string(), slackUserId: z.string() }).optional(),
  }),
]);
export type Principal = z.infer<typeof PrincipalSchema>;

export function principalLabel(p: Principal): string {
  return p.kind === 'user' ? p.email : `Gemini service (${p.serviceAccount.split('@')[0]})`;
}

/** Identity string for provenance: `user:<email>` or `service:<sa-email>`. */
export function principalId(p: Principal): string {
  return p.kind === 'user' ? `user:${p.email}` : `service:${p.serviceAccount}`;
}

/** Per-channel identity policy (ADR-0001 §5). Default `user-only`. */
export const IdentityPolicySchema = z.enum(['user-only', 'user-preferred', 'service-only']);
export type IdentityPolicy = z.infer<typeof IdentityPolicySchema>;

export const ChannelPolicySchema = z.object({
  identity: IdentityPolicySchema.default('user-only'),
  /** Ground aliases the service principal may use in this channel (intersected with catalog). */
  serviceGrounds: z.array(z.string()).default([]),
  /** May the service principal read this channel's messages? Default false (fail closed). */
  serviceMayRead: z.boolean().default(false),
  /** Allow unattended automations to auto-apply low-risk effects here. Default false. */
  autoApply: z.boolean().default(false),
});
export type ChannelPolicy = z.infer<typeof ChannelPolicySchema>;

export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  identity: 'user-only',
  serviceGrounds: [],
  serviceMayRead: false,
  autoApply: false,
};

export interface PrincipalDecisionInput {
  policy: IdentityPolicy;
  /** Is the invoker (or automation owner) linked to their IdP? */
  linked: boolean;
  /** Has the linked user granted offline access (needed for run-as-me automations)? */
  offlineGranted: boolean;
  requested?: RunAs;
  unattended: boolean;
  /** Slack Connect / externally shared conversation. */
  externallyShared: boolean;
  /** Is a licensed service account configured at all? */
  serviceConfigured: boolean;
}

export type PrincipalDecision =
  | { ok: true; kind: 'user' | 'service'; coerced?: string }
  | {
      ok: false;
      reason: 'needs-link' | 'service-denied' | 'service-unavailable' | 'offline-required';
      /** Offer the "Answer with the Gemini service" button alongside Connect. */
      offerService: boolean;
      message: string;
    };

/**
 * The pure principal policy. Fails closed: when in doubt it asks the user to connect rather than
 * silently falling back to the (broader or different) service identity.
 */
export function decidePrincipal(input: PrincipalDecisionInput): PrincipalDecision {
  const policy: IdentityPolicy = input.externallyShared ? 'service-only' : input.policy;
  const coerced =
    input.externallyShared && input.policy !== 'service-only'
      ? 'Externally shared channel — answers use the Gemini service and shared sources only.'
      : undefined;
  const serviceOk = (): PrincipalDecision =>
    input.serviceConfigured
      ? { ok: true, kind: 'service', ...(coerced ? { coerced } : {}) }
      : {
          ok: false,
          reason: 'service-unavailable',
          offerService: false,
          message: 'No Gemini service account is configured for this workspace.',
        };

  if (policy === 'service-only') {
    if (input.requested === 'me') {
      return {
        ok: false,
        reason: 'service-denied',
        offerService: false,
        message:
          'This channel only uses the Gemini service identity; --as me is not available here.',
      };
    }
    return serviceOk();
  }

  if (input.requested === 'service') {
    if (policy === 'user-only') {
      return {
        ok: false,
        reason: 'service-denied',
        offerService: false,
        message: 'This channel requires answers to run as you. Connect your account to continue.',
      };
    }
    return serviceOk();
  }

  if (input.unattended) {
    if (input.requested === 'me') {
      if (!input.linked) {
        return {
          ok: false,
          reason: 'needs-link',
          offerService: false,
          message: 'The automation owner is no longer connected.',
        };
      }
      if (!input.offlineGranted) {
        return {
          ok: false,
          reason: 'offline-required',
          offerService: policy === 'user-preferred',
          message: 'Run-as-me automations need offline access. Reconnect with offline access on.',
        };
      }
      return { ok: true, kind: 'user' };
    }
    // Unattended with no explicit choice: service where allowed, else the owner with offline access.
    if (policy === 'user-preferred') return serviceOk();
    if (input.linked && input.offlineGranted) return { ok: true, kind: 'user' };
    return {
      ok: false,
      reason: 'offline-required',
      offerService: false,
      message:
        'This channel requires runs as a person; the owner must connect with offline access.',
    };
  }

  if (input.linked) return { ok: true, kind: 'user' };
  return {
    ok: false,
    reason: 'needs-link',
    offerService: policy === 'user-preferred' && input.serviceConfigured,
    message: 'Connect Gemini Enterprise so answers use your licence and only sources you can open.',
  };
}
