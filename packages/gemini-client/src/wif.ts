import { z } from 'zod';
import { withRetry, defaultIsRetriable, HttpError, type RetryOptions } from './retry.js';
import { CachedTokenSource, safeText } from './token-source.js';

/**
 * Workforce Identity Federation (RFC 8693) for the **user** principal. The signed-in user's IdP
 * OIDC id_token (Entra, Okta, Ping…) is exchanged at Google STS for a short-lived Google access
 * token. No Google service-account key is involved. Ported from ge-msft `WifTokenClient`; the
 * subject token provider is IdP-neutral because the Slack bot links any OIDC IdP.
 */
export interface SubjectTokenProvider {
  /** A fresh OIDC id_token for this user (from the identity broker's refresh flow). */
  getIdToken(): Promise<string>;
}

export interface WifConfig {
  poolId: string;
  providerId: string;
  scope?: string;
  /** Billing/quota project passed via STS `options.userProject`. */
  userProject?: string;
  stsEndpoint?: string;
}

const STS_ENDPOINT = 'https://sts.googleapis.com/v1/token';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const StsResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
});

export function workforceAudience(cfg: Pick<WifConfig, 'poolId' | 'providerId'>): string {
  return (
    `//iam.googleapis.com/locations/global/workforcePools/` +
    `${cfg.poolId}/providers/${cfg.providerId}`
  );
}

export class WifTokenClient extends CachedTokenSource {
  constructor(
    private readonly subject: SubjectTokenProvider,
    private readonly config: WifConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    now: () => number = Date.now,
    private readonly retryOpts: RetryOptions = {},
  ) {
    super(now);
  }

  protected async mint(): Promise<{ token: string; expiresInSeconds: number }> {
    const idToken = await this.subject.getIdToken();
    const body: Record<string, string> = {
      grantType: TOKEN_EXCHANGE_GRANT,
      audience: workforceAudience(this.config),
      scope: this.config.scope ?? CLOUD_PLATFORM_SCOPE,
      requestedTokenType: ACCESS_TOKEN_TYPE,
      subjectToken: idToken,
      subjectTokenType: ID_TOKEN_TYPE,
    };
    if (this.config.userProject) {
      body.options = JSON.stringify({ userProject: this.config.userProject });
    }
    const res = await withRetry(async () => {
      const r = await this.fetchImpl(this.config.stsEndpoint ?? STS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok && defaultIsRetriable(new HttpError(r.status, ''))) {
        throw new HttpError(
          r.status,
          `WIF token exchange failed (${r.status}): ${await safeText(r)}`,
        );
      }
      return r;
    }, this.retryOpts);
    if (!res.ok) {
      throw new Error(`WIF token exchange failed (${res.status}): ${await safeText(res)}`);
    }
    const parsed = StsResponseSchema.parse(await res.json());
    return { token: parsed.access_token, expiresInSeconds: parsed.expires_in ?? 3600 };
  }
}

/**
 * Google-identity tenants (Cloud Identity / Workspace users): the user's own Google OAuth access
 * token is the credential — no STS hop. The broker supplies a refresher.
 */
export class GoogleUserTokenSource extends CachedTokenSource {
  constructor(
    private readonly refresh: () => Promise<{ accessToken: string; expiresInSeconds: number }>,
    now: () => number = Date.now,
  ) {
    super(now);
  }

  protected async mint(): Promise<{ token: string; expiresInSeconds: number }> {
    const r = await this.refresh();
    return { token: r.accessToken, expiresInSeconds: r.expiresInSeconds };
  }
}
