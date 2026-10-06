import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IdpKind } from '@ge-slack/contracts';

/**
 * OIDC authorization-code + PKCE against the tenant IdP registered as the Workforce Identity Pool
 * provider (Entra, Okta, Ping…), or Google for Google-identity tenants. The bot is a confidential
 * client (it has a server), so it also authenticates to the token endpoint when a secret is set;
 * PKCE is used regardless (defence in depth against code interception).
 */
export interface OidcProviderConfig {
  kind: IdpKind;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Extra scopes; `openid email profile` are always requested. Google adds cloud-platform. */
  scopes?: string[];
  /** Display name for the Connect button ("Acme SSO"). */
  displayName: string;
}

const DiscoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
});
type Discovery = z.infer<typeof DiscoverySchema>;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const IdTokenClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  upn: z.string().optional(),
  email_verified: z.boolean().optional(),
});
export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

export const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomToken(bytes = 24): string {
  return base64url(randomBytes(bytes));
}

export class OidcClient {
  private discovery: Promise<Discovery> | null = null;

  constructor(
    readonly config: OidcProviderConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly now: () => number = Date.now,
  ) {
    if (!config.issuer.startsWith('https://')) throw new Error('OIDC issuer must be https');
    if (
      !/^https:\/\//.test(config.redirectUri) &&
      !/^http:\/\/localhost[:/]/.test(config.redirectUri)
    ) {
      throw new Error('OIDC redirectUri must be https (localhost http allowed for dev)');
    }
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
      const d = DiscoverySchema.parse(await res.json());
      if (d.issuer.replace(/\/$/, '') !== this.config.issuer.replace(/\/$/, '')) {
        throw new Error('OIDC discovery issuer mismatch');
      }
      return d;
    })().catch((e) => {
      this.discovery = null;
      throw e;
    });
    return this.discovery;
  }

  /**
   * A refresh token is always needed: every turn mints a fresh id_token for the STS exchange.
   * Whether automations may run as the user while they're away is a separate, user-controlled
   * policy flag (`allowUnattended`), not an OAuth scope.
   */
  scopes(): string[] {
    const s = new Set(['openid', 'email', 'profile', ...(this.config.scopes ?? [])]);
    if (this.config.kind === 'google') s.add(GOOGLE_CLOUD_SCOPE);
    // Entra/Okta issue refresh tokens for offline_access; Google uses access_type=offline instead.
    else s.add('offline_access');
    return [...s];
  }

  async authorizeUrl(p: {
    state: string;
    nonce: string;
    codeChallenge: string;
    loginHint?: string;
  }): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('redirect_uri', this.config.redirectUri);
    u.searchParams.set('scope', this.scopes().join(' '));
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    if (this.config.kind === 'google') {
      // Google issues a refresh token only with access_type=offline (+consent on re-link).
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
    }
    return u.toString();
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** RFC 7009 revocation, if the IdP advertises it. Never throws for "unsupported". */
  async revoke(refreshToken: string): Promise<void> {
    const d = await this.discover();
    if (!d.revocation_endpoint) return;
    const body = new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    await this.fetchImpl(d.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const d = await this.discover();
    const body = new URLSearchParams({ ...params, client_id: this.config.clientId });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      // Only the OAuth error code is surfaced — never the body, which can echo request params.
      let code = 'token_error';
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === 'string') code = j.error.slice(0, 64);
      } catch {
        /* ignore */
      }
      throw new OidcError(code, res.status);
    }
    return TokenResponseSchema.parse(await res.json());
  }

  /**
   * Validate id_token claims. The token comes straight from the token endpoint over TLS, so per
   * OIDC Core §3.1.3.7(6) TLS server validation stands in for signature validation here; Google
   * STS independently verifies the signature against the provider's JWKS on every exchange.
   */
  validateIdToken(idToken: string, expectedNonce?: string): IdTokenClaims {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new OidcError('malformed_id_token');
    let claims: IdTokenClaims;
    try {
      claims = IdTokenClaimsSchema.parse(
        JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
      );
    } catch {
      throw new OidcError('malformed_id_token');
    }
    if (claims.iss.replace(/\/$/, '') !== this.config.issuer.replace(/\/$/, '')) {
      throw new OidcError('issuer_mismatch');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.clientId)) throw new OidcError('audience_mismatch');
    if (claims.exp * 1000 < this.now() - 60_000) throw new OidcError('id_token_expired');
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce)
      throw new OidcError('nonce_mismatch');
    return claims;
  }
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`OIDC ${code}${status ? ` (${status})` : ''}`);
    this.name = 'OidcError';
  }
}

/** The identity email to bind against Slack's profile email. */
export function claimEmail(c: IdTokenClaims): string | undefined {
  // An explicitly unverified email is never used for binding (L1).
  if (c.email !== undefined && c.email_verified === false) return undefined;
  const e = c.email ?? c.preferred_username ?? c.upn;
  return e && /^[^@\s]+@[^@\s]+$/.test(e) ? e.toLowerCase() : undefined;
}
