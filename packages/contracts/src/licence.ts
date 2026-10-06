import { z } from 'zod';

/**
 * Licence-aware onboarding (EXPERIENCE §11, ADR-0003 §1). A Gemini Enterprise licence belongs to
 * the person's workforce identity, never to their Slack account; the bot only *reads* the
 * assignment so it can say so before a request fails, and routes a request to an admin.
 */

/** What Gemini Enterprise's user store says (`userLicenses.licenseAssignmentState`). */
export const LicenceApiStateSchema = z.enum([
  'LICENSE_ASSIGNMENT_STATE_UNSPECIFIED',
  'ASSIGNED',
  'UNASSIGNED',
  'NO_LICENSE',
  'NO_LICENSE_ATTEMPTED_LOGIN',
  'BLOCKED',
]);
export type LicenceApiState = z.infer<typeof LicenceApiStateSchema>;

/**
 * - `assigned`: licensed.
 * - `unlicensed`: in the user store without a licence.
 * - `blocked`: an admin blocked licence assignment for this person.
 * - `unknown`: not in the user store yet (auto-register may still assign one on first use), or the
 *   lookup isn't configured or failed. Never blocks a request: Gemini Enterprise decides.
 */
export type LicenceStatus = 'assigned' | 'unlicensed' | 'blocked' | 'unknown';

export function licenceStatusFrom(state: string | undefined): LicenceStatus {
  switch (state) {
    case 'ASSIGNED':
      return 'assigned';
    case 'UNASSIGNED':
    case 'NO_LICENSE':
    case 'NO_LICENSE_ATTEMPTED_LOGIN':
      return 'unlicensed';
    case 'BLOCKED':
      return 'blocked';
    default:
      return 'unknown';
  }
}

/** Only a known-missing licence stops a turn early; everything else lets Gemini Enterprise decide. */
export function licenceBlocksTurn(s: LicenceStatus): boolean {
  return s === 'unlicensed' || s === 'blocked';
}

/** A blocked person can't be licensed by request: an admin unblocked them deliberately or not. */
export function licenceRequestable(s: LicenceStatus): boolean {
  return s === 'unlicensed' || s === 'unknown';
}

export const LICENCE_LIMITS = {
  /** How long a known status is trusted before it is looked up again. */
  assignedTtlMs: 6 * 3_600_000,
  missingTtlMs: 15 * 60_000,
  /** One open request per person; a decided one can be re-requested after this. */
  requestCooldownMs: 7 * 86_400_000,
  requestRetainMs: 30 * 86_400_000,
} as const;

export type LicenceRequestStatus = 'open' | 'approved' | 'assigned' | 'declined';

export interface LicenceRequest {
  id: string;
  teamId: string;
  requesterId: string;
  /** The verified email of the requester's linked identity at request time. */
  email: string;
  status: LicenceRequestStatus;
  at: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Where the admin card was posted, so it can be updated when someone decides. */
  card?: { channel: string; ts: string };
}

/** Which principal string Gemini Enterprise's user store keys this person by. */
export type LicencePrincipalField = 'email' | 'subject';

/** `user_principal = "…"` with the value quoted and escaped (the filter is a small grammar). */
export function licenceFilter(principal: string): string {
  if (!principal || /[\p{Cc}]/u.test(principal) || principal.length > 320) {
    throw new Error('Invalid licence principal');
  }
  return `user_principal = "${principal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
