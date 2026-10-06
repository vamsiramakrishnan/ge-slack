import {
  licenceFilter,
  licenceStatusFrom,
  samePrincipal,
  type LicencePrincipalField,
  type LicenceStatus,
} from '@ge-slack/contracts';
import { discoveryEngineHost, proxyBase, type GeminiClientConfig } from './config.js';
import { safeText, type TokenSource } from './token-source.js';

export interface LicenceLookup {
  status: LicenceStatus;
  /** The user store's own spelling of the principal, when a row was found (assign to exactly it). */
  principal?: string;
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
 *   `discoveryengine.userStores.listUserLicenses` on the user store.
 * - `assign`: `POST {userStore}:batchUpdateUserLicenses` with one principal and one licence
 *   config, then polls the returned operation to its final response. Needs
 *   `discoveryengine.userStores.batchUpdateUserLicenses` (and `discoveryengine.operations.get`).
 *   Only called after a workspace admin approves a request; assigning the same config twice is
 *   harmless.
 */
export class LicenceDirectory {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly userStore = 'default_user_store',
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    /** Operation polling (≈ 20 s by default); injectable for tests. */
    private readonly pollMs = 1_000,
    private readonly pollAttempts = 20,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!/^[\w-]{1,128}$/.test(userStore)) throw new Error('Invalid user store id');
  }

  private base(): string {
    // Through the proxy, the store stays in the path; the proxy must pin project and region.
    if (this.config.proxyUrl)
      return `${proxyBase(this.config.proxyUrl)}/user-stores/${this.userStore}`;
    const a = this.config.assistant;
    return `${discoveryEngineHost(a.location)}/v1alpha/projects/${a.project}/locations/${a.location}/userStores/${this.userStore}`;
  }

  async lookup(
    tokens: TokenSource,
    principal: string,
    field: LicencePrincipalField = 'email',
  ): Promise<LicenceLookup> {
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
    const row = (body.userLicenses ?? []).find(
      (r) =>
        typeof r.userPrincipal === 'string' && samePrincipal(field, r.userPrincipal, principal),
    );
    if (!row) return { status: 'unknown', reason: 'not-found' };
    const found = String(row.userPrincipal);
    const status = licenceStatusFrom(
      typeof row.licenseAssignmentState === 'string' ? row.licenseAssignmentState : undefined,
    );
    return status === 'unknown'
      ? { status, reason: 'unspecified', principal: found }
      : { status, principal: found };
  }

  async assign(
    tokens: TokenSource,
    principal: string,
    licenseConfig: string,
  ): Promise<LicenceAssignResult> {
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
    // The reply is a long-running operation: only its final response says whether this person
    // was updated (a per-user failure lands in `errorSamples`).
    let op = await readOperation(res);
    for (let i = 0; op && !op.done && i < this.pollAttempts; i++) {
      await this.sleep(this.pollMs);
      if (!OPERATION_RE.test(op.name ?? '')) return { ok: false, code: 'bad_operation' };
      try {
        const r = await this.fetchImpl(`${this.host()}/v1alpha/${op.name}`, {
          headers: { Authorization: `Bearer ${await tokens.getAccessToken()}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) {
          await safeText(r);
          continue;
        }
        op = await readOperation(r);
      } catch {
        /* keep polling until the attempts run out */
      }
    }
    if (!op) return { ok: false, code: 'bad_reply', pending: true };
    if (!op.done) return { ok: false, code: 'pending', pending: true };
    if (op.error) return { ok: false, code: `op_${op.error.code ?? 'error'}` };
    const resp = op.response ?? {};
    if (resp.errorSamples?.length) {
      return { ok: false, code: `user_${resp.errorSamples[0]?.code ?? 'error'}` };
    }
    const updated = (resp.userLicenses ?? []).some(
      (u) =>
        typeof u.userPrincipal === 'string' &&
        u.userPrincipal.toLowerCase() === principal.toLowerCase(),
    );
    return updated ? { ok: true } : { ok: false, code: 'not_updated' };
  }

  private host(): string {
    return this.config.proxyUrl
      ? proxyBase(this.config.proxyUrl)
      : discoveryEngineHost(this.config.assistant.location);
  }
}

/**
 * `pending`: Gemini Enterprise accepted the change but hadn't finished when we stopped waiting;
 * it may still land (approving again is safe: the same assignment is idempotent).
 */
export type LicenceAssignResult = { ok: true } | { ok: false; code: string; pending?: boolean };

const OPERATION_RE =
  /^projects\/[^/\s]+\/locations\/[a-z0-9-]+\/(?:userStores\/[\w-]+\/)?operations\/[\w.-]+$/;

interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number };
  response?: {
    errorSamples?: Array<{ code?: number }>;
    userLicenses?: Array<{ userPrincipal?: unknown }>;
  };
}

async function readOperation(res: Response): Promise<Operation | undefined> {
  try {
    return (await res.json()) as Operation;
  } catch {
    return undefined;
  }
}

export function isLicenceConfigName(s: string): boolean {
  return LICENCE_CONFIG_RE.test(s);
}
