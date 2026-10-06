import { licenceFilter, licenceStatusFrom, type LicenceStatus } from '@ge-slack/contracts';
import { discoveryEngineHost, proxyBase, type GeminiClientConfig } from './config.js';
import { safeText, type TokenSource } from './token-source.js';

export interface LicenceLookup {
  status: LicenceStatus;
  /** Why the status is `unknown` (`not-found`, `http_403`, `network`, …); never a provider body. */
  reason?: string;
}

const LICENCE_CONFIG_RE =
  /^projects\/[^/\s]+\/locations\/[a-z0-9-]+\/licenseConfigs\/[\w-]{1,128}$/;

/**
 * Gemini Enterprise user licences (`userStores.userLicenses`), called with an admin-plane identity
 * (ADR-0003 §1) — never a person's own token, which can't read the user store.
 *
 * - `lookup`: `GET {userStore}/userLicenses?filter=user_principal = "…"`. Needs
 *   `discoveryengine.userLicenses.list`.
 * - `assign`: `POST {userStore}:batchUpdateUserLicenses` with one principal and one licence
 *   config. Needs `discoveryengine.userStores.batchUpdateUserLicenses`. Only called after a
 *   workspace admin approves a request; assigning the same config twice is harmless.
 */
export class LicenceDirectory {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly userStore = 'default_user_store',
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {
    if (!/^[\w-]{1,128}$/.test(userStore)) throw new Error('Invalid user store id');
  }

  private base(): string {
    if (this.config.proxyUrl) return `${proxyBase(this.config.proxyUrl)}/user-licenses`;
    const a = this.config.assistant;
    return `${discoveryEngineHost(a.location)}/v1alpha/projects/${a.project}/locations/${a.location}/userStores/${this.userStore}`;
  }

  async lookup(tokens: TokenSource, principal: string): Promise<LicenceLookup> {
    const url = `${this.base()}/userLicenses?pageSize=5&filter=${encodeURIComponent(licenceFilter(principal))}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${await tokens.getAccessToken()}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { status: 'unknown', reason: 'network' };
    }
    if (!res.ok) {
      await safeText(res); // drain; the body is never shown
      return { status: 'unknown', reason: `http_${res.status}` };
    }
    let body: {
      userLicenses?: Array<{ userPrincipal?: unknown; licenseAssignmentState?: unknown }>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { status: 'unknown', reason: 'bad_reply' };
    }
    // The filter is exact, but match again: never take another person's row as this one's.
    const want = principal.toLowerCase();
    const row = (body.userLicenses ?? []).find(
      (r) => typeof r.userPrincipal === 'string' && r.userPrincipal.toLowerCase() === want,
    );
    if (!row) return { status: 'unknown', reason: 'not-found' };
    const status = licenceStatusFrom(
      typeof row.licenseAssignmentState === 'string' ? row.licenseAssignmentState : undefined,
    );
    return status === 'unknown' ? { status, reason: 'unspecified' } : { status };
  }

  async assign(
    tokens: TokenSource,
    principal: string,
    licenseConfig: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (!LICENCE_CONFIG_RE.test(licenseConfig)) return { ok: false, code: 'bad_config' };
    licenceFilter(principal); // same validation as lookup
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}:batchUpdateUserLicenses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokens.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inlineSource: {
            userLicenses: [{ userPrincipal: principal, licenseConfig }],
            updateMask: 'licenseConfig',
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { ok: false, code: 'network' };
    }
    if (!res.ok) {
      await safeText(res);
      return { ok: false, code: `http_${res.status}` };
    }
    return { ok: true };
  }
}

export function isLicenceConfigName(s: string): boolean {
  return LICENCE_CONFIG_RE.test(s);
}
