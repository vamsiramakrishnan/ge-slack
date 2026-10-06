import type { IdpKind } from '@ge-slack/contracts';
import type { KeyValueStore } from './store.js';
import { TokenVault, userAad, type SealedSecret } from './vault.js';
import { OidcClient, OidcError, claimEmail, newPkce, randomToken } from './oidc.js';

/** What we persist per linked Slack user. The refresh token is sealed; nothing else is secret. */
export interface LinkedIdentity {
  teamId: string;
  slackUserId: string;
  provider: IdpKind;
  subject: string;
  email: string;
  /** User opted in to run-as-me automations while they're away. */
  allowUnattended: boolean;
  linkedAt: string;
  refresh: SealedSecret;
}

interface PendingLink {
  teamId: string;
  slackUserId: string;
  verifier: string;
  nonce: string;
  allowUnattended: boolean;
  /** Opaque id of a pending invocation to resume after linking. */
  resumeId?: string;
}

export const LINK_STATE_TTL_MS = 10 * 60_000;

export const identityKey = (teamId: string, userId: string) => `identity/${teamId}/${userId}`;
const stateKey = (state: string) => `oauth-state/${state}`;

export interface EmailBindingPolicy {
  /** Require IdP email == Slack profile email. Default true; disabling is an admin decision. */
  enforce: boolean;
  /** Equivalent domains, e.g. { 'acme.io': 'acme.com' } (Slack domain → IdP domain). */
  domainAliases?: Record<string, string>;
}

export type LinkOutcome =
  | { ok: true; teamId: string; slackUserId: string; email: string; resumeId?: string }
  | {
      ok: false;
      reason:
        | 'expired-state'
        | 'idp-error'
        | 'no-refresh-token'
        | 'email-mismatch'
        | 'no-email'
        | 'invalid-id-token';
      message: string;
    };

/**
 * Account linking (ADR-0001 §3). `start` creates a one-time `state` bound to the Slack user and
 * a PKCE verifier; `complete` (the OAuth callback) consumes it exactly once, validates the
 * id_token, enforces the email binding, and seals the refresh token under the user's AAD.
 */
export class AccountLinker {
  constructor(
    private readonly store: KeyValueStore,
    private readonly vault: TokenVault,
    private readonly oidc: OidcClient,
    private readonly binding: EmailBindingPolicy = { enforce: true },
    private readonly now: () => number = Date.now,
  ) {}

  async start(p: {
    teamId: string;
    slackUserId: string;
    allowUnattended?: boolean;
    resumeId?: string;
    loginHint?: string;
  }): Promise<string> {
    const state = randomToken();
    const nonce = randomToken(16);
    const { verifier, challenge } = newPkce();
    const pending: PendingLink = {
      teamId: p.teamId,
      slackUserId: p.slackUserId,
      verifier,
      nonce,
      allowUnattended: p.allowUnattended ?? false,
      ...(p.resumeId ? { resumeId: p.resumeId } : {}),
    };
    await this.store.set(stateKey(state), pending, { ttlMs: LINK_STATE_TTL_MS });
    return this.oidc.authorizeUrl({
      state,
      nonce,
      codeChallenge: challenge,
      ...(p.loginHint ? { loginHint: p.loginHint } : {}),
    });
  }

  async complete(
    state: string,
    code: string,
    slackEmail: (teamId: string, userId: string) => Promise<string | undefined>,
  ): Promise<LinkOutcome> {
    const pending = await this.store.take<PendingLink>(stateKey(state));
    if (!pending) {
      return {
        ok: false,
        reason: 'expired-state',
        message: 'This sign-in link expired. Run /gemini connect again.',
      };
    }
    let tokens;
    try {
      tokens = await this.oidc.exchangeCode(code, pending.verifier);
    } catch (e) {
      const c = e instanceof OidcError ? e.code : 'token_error';
      return {
        ok: false,
        reason: 'idp-error',
        message: `Sign-in failed at your identity provider (${c}).`,
      };
    }
    if (!tokens.id_token) {
      return {
        ok: false,
        reason: 'invalid-id-token',
        message: 'Your identity provider did not return an id_token.',
      };
    }
    if (!tokens.refresh_token) {
      return {
        ok: false,
        reason: 'no-refresh-token',
        message:
          'Your identity provider did not issue a refresh token. Ask an admin to allow offline_access for this app.',
      };
    }
    let claims;
    try {
      claims = this.oidc.validateIdToken(tokens.id_token, pending.nonce);
    } catch (e) {
      return {
        ok: false,
        reason: 'invalid-id-token',
        message: `Sign-in could not be verified (${e instanceof OidcError ? e.code : 'invalid'}).`,
      };
    }
    const email = claimEmail(claims);
    if (!email)
      return {
        ok: false,
        reason: 'no-email',
        message: 'Your identity has no email claim to match against Slack.',
      };

    if (this.binding.enforce) {
      const slack = (await slackEmail(pending.teamId, pending.slackUserId))?.toLowerCase();
      if (!slack || normalizeDomain(slack, this.binding.domainAliases) !== email) {
        return {
          ok: false,
          reason: 'email-mismatch',
          message:
            'The account you signed in with does not match your Slack email. Sign in as yourself.',
        };
      }
    }

    const record: LinkedIdentity = {
      teamId: pending.teamId,
      slackUserId: pending.slackUserId,
      provider: this.oidc.config.kind,
      subject: claims.sub,
      email,
      allowUnattended: pending.allowUnattended,
      linkedAt: new Date(this.now()).toISOString(),
      refresh: await this.vault.seal(
        tokens.refresh_token,
        userAad(pending.teamId, pending.slackUserId),
      ),
    };
    await this.store.set(identityKey(pending.teamId, pending.slackUserId), record);
    return {
      ok: true,
      teamId: pending.teamId,
      slackUserId: pending.slackUserId,
      email,
      ...(pending.resumeId ? { resumeId: pending.resumeId } : {}),
    };
  }
}

function normalizeDomain(email: string, aliases: Record<string, string> = {}): string {
  const [local, domain] = email.split('@') as [string, string];
  return `${local}@${aliases[domain] ?? domain}`;
}
