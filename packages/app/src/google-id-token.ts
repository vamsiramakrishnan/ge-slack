import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

/**
 * Verifies Google-signed OIDC ID tokens (Cloud Scheduler → `/cron/tick`), so the scheduler needs
 * no shared secret that could leak through job config, argv or gcloud logs. RS256 only; checks
 * signature, issuer, audience, expiry, and the exact invoker service account.
 */
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const SKEW_S = 60;

type Jwk = JsonWebKey & { kid?: string; alg?: string };

export class GoogleIdTokenVerifier {
  private keys: { byKid: Map<string, Jwk>; expiresAt: number } | undefined;
  private inflight: Promise<Map<string, Jwk>> | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** True only for a valid Google ID token for `audience`, issued to `email` (verified). */
  async verify(token: string, expect: { audience: string; email: string }): Promise<boolean> {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as typeof header;
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (header.alg !== 'RS256' || !header.kid) return false;
    let jwk = (await this.jwks(false)).get(header.kid);
    // Google rotates keys: one forced refresh for an unknown kid, then fail closed.
    if (!jwk) jwk = (await this.jwks(true)).get(header.kid);
    if (!jwk) return false;
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      ok = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        key,
        Buffer.from(s, 'base64url'),
      );
    } catch {
      return false;
    }
    if (!ok) return false;
    const nowS = Math.floor(this.now() / 1000);
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    const iat = typeof claims.iat === 'number' ? claims.iat : Infinity;
    return (
      ISSUERS.has(String(claims.iss)) &&
      claims.aud === expect.audience &&
      exp + SKEW_S > nowS &&
      iat - SKEW_S <= nowS &&
      claims.email === expect.email &&
      claims.email_verified === true
    );
  }

  private async jwks(force: boolean): Promise<Map<string, Jwk>> {
    if (!force && this.keys && this.keys.expiresAt > this.now()) return this.keys.byKid;
    this.inflight ??= (async () => {
      try {
        const res = await this.fetchImpl(GOOGLE_CERTS);
        if (!res.ok) throw new Error(`Google certs ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
        const byKid = new Map(
          (body.keys ?? []).filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid!, k]),
        );
        this.keys = {
          byKid,
          expiresAt: this.now() + Math.min(Number(maxAge ?? 3600), 86_400) * 1000,
        };
        return byKid;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}
