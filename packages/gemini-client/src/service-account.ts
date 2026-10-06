import { z } from 'zod';
import { withRetry, defaultIsRetriable, HttpError, type RetryOptions } from './retry.js';
import { CachedTokenSource, safeText, type TokenSource } from './token-source.js';
import { CLOUD_PLATFORM_SCOPE } from './wif.js';

/**
 * Token sources for the **service** principal: a service account that holds a Gemini Enterprise
 * licence. Both are keyless (ADR-0001 §4) — no JSON key file is ever read.
 *
 * - `MetadataServerTokenSource`: the bot's runtime SA *is* the licensed SA (Cloud Run / GKE
 *   attached identity).
 * - `ImpersonatedTokenSource`: the runtime SA holds `roles/iam.serviceAccountTokenCreator` on the
 *   licensed SA only, and mints short-lived tokens for it via IAM Credentials.
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_EMAIL_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email';

const MetadataTokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });

export class MetadataServerTokenSource extends CachedTokenSource {
  constructor(
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly scopes: string[] = [CLOUD_PLATFORM_SCOPE],
    now: () => number = Date.now,
    private readonly retryOpts: RetryOptions = {},
  ) {
    super(now);
  }

  protected async mint(): Promise<{ token: string; expiresInSeconds: number }> {
    const url = `${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(this.scopes.join(','))}`;
    const res = await withRetry(async () => {
      const r = await this.fetchImpl(url, { headers: { 'Metadata-Flavor': 'Google' } });
      if (!r.ok && defaultIsRetriable(new HttpError(r.status, ''))) {
        throw new HttpError(r.status, `metadata token failed (${r.status})`);
      }
      return r;
    }, this.retryOpts);
    if (!res.ok) throw new Error(`metadata token failed (${res.status}): ${await safeText(res)}`);
    const parsed = MetadataTokenSchema.parse(await res.json());
    return { token: parsed.access_token, expiresInSeconds: parsed.expires_in };
  }

  /** The attached service account's email (used to verify it matches GE_SERVICE_ACCOUNT). */
  async email(): Promise<string> {
    const r = await this.fetchImpl(METADATA_EMAIL_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!r.ok) throw new Error(`metadata email failed (${r.status})`);
    return (await r.text()).trim();
  }
}

const GenerateAccessTokenSchema = z.object({ accessToken: z.string(), expireTime: z.string() });

export interface ImpersonationConfig {
  /** The GE-licensed service account email. */
  targetServiceAccount: string;
  scopes?: string[];
  /** Seconds, max 3600 without org policy changes. */
  lifetimeSeconds?: number;
  endpoint?: string;
}

export class ImpersonatedTokenSource extends CachedTokenSource {
  constructor(
    private readonly base: TokenSource,
    private readonly config: ImpersonationConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    now: () => number = Date.now,
    private readonly retryOpts: RetryOptions = {},
  ) {
    super(now);
    if (!/^[^@\s/]+@[^@\s/]+\.iam\.gserviceaccount\.com$/.test(config.targetServiceAccount)) {
      throw new Error('targetServiceAccount must be a service account email');
    }
  }

  protected async mint(): Promise<{ token: string; expiresInSeconds: number }> {
    const endpoint = this.config.endpoint ?? 'https://iamcredentials.googleapis.com';
    const url = `${endpoint}/v1/projects/-/serviceAccounts/${encodeURIComponent(this.config.targetServiceAccount)}:generateAccessToken`;
    const lifetime = Math.min(this.config.lifetimeSeconds ?? 3600, 3600);
    const body = JSON.stringify({
      scope: this.config.scopes ?? [CLOUD_PLATFORM_SCOPE],
      lifetime: `${lifetime}s`,
    });
    const send = async () =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.base.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    let res = await withRetry(async () => {
      const r = await send();
      if (!r.ok && r.status !== 401 && defaultIsRetriable(new HttpError(r.status, ''))) {
        throw new HttpError(r.status, `generateAccessToken failed (${r.status})`);
      }
      return r;
    }, this.retryOpts);
    if (res.status === 401 && this.base.invalidate) {
      this.base.invalidate();
      res = await send();
    }
    if (!res.ok)
      throw new Error(`generateAccessToken failed (${res.status}): ${await safeText(res)}`);
    const parsed = GenerateAccessTokenSchema.parse(await res.json());
    const expiresInSeconds = Math.max(
      0,
      Math.floor((Date.parse(parsed.expireTime) - this.now()) / 1000),
    );
    return { token: parsed.accessToken, expiresInSeconds };
  }
}
