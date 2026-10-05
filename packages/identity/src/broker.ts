import {
  decidePrincipal,
  principalId,
  type IdentityPolicy,
  type Principal,
  type PrincipalDecision,
  type RunAs,
} from '@ge-slack/contracts';
import {
  GoogleUserTokenSource,
  WifTokenClient,
  type TokenSource,
  type WifConfig,
} from '@ge-slack/gemini-client';
import type { KeyValueStore } from './store.js';
import { TokenVault, userAad } from './vault.js';
import { OidcClient, OidcError } from './oidc.js';
import { identityKey, type LinkedIdentity } from './linking.js';

export interface ServiceIdentity {
  /** The GE-licensed service account email. */
  serviceAccount: string;
  tokens: TokenSource;
}

export interface BrokerOptions {
  store: KeyValueStore;
  vault: TokenVault;
  oidc: OidcClient;
  /** Required for `oidc` providers; unused for `google`. */
  wif?: WifConfig;
  service?: ServiceIdentity;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Max per-user token sources kept in memory. */
  maxCachedUsers?: number;
}

export interface ResolveInput {
  teamId: string;
  userId: string;
  policy: IdentityPolicy;
  requested?: RunAs;
  unattended: boolean;
  externallyShared: boolean;
}

export type Resolved =
  | { ok: true; principal: Principal; tokens: TokenSource; identity: string; notice?: string }
  | { ok: false; decision: Extract<PrincipalDecision, { ok: false }> };

/** Raised when the IdP refuses a refresh (revoked, expired, password reset). The link is dropped. */
export class IdentityRevokedError extends Error {
  constructor() {
    super('Your Gemini Enterprise connection expired. Connect again to continue.');
    this.name = 'IdentityRevokedError';
  }
}

/**
 * Resolves exactly one principal per turn and hands out a memory-only `TokenSource` for it.
 * User tokens: sealed IdP refresh token → fresh id_token → WIF STS (or Google access token).
 * Service tokens: the configured keyless service-account source.
 */
export class IdentityBroker {
  private readonly cache = new Map<string, TokenSource>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: BrokerOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
    this.now = opts.now ?? Date.now;
    if (opts.oidc.config.kind === 'oidc' && !opts.wif) {
      throw new Error('OIDC providers require a Workforce Identity Federation config');
    }
  }

  get serviceConfigured(): boolean {
    return this.opts.service !== undefined;
  }

  get serviceAccount(): string | undefined {
    return this.opts.service?.serviceAccount;
  }

  async getLinked(teamId: string, userId: string): Promise<LinkedIdentity | undefined> {
    return this.opts.store.get<LinkedIdentity>(identityKey(teamId, userId));
  }

  async setAllowUnattended(teamId: string, userId: string, allow: boolean): Promise<boolean> {
    const rec = await this.getLinked(teamId, userId);
    if (!rec) return false;
    await this.opts.store.set(identityKey(teamId, userId), { ...rec, allowUnattended: allow });
    return true;
  }

  /** Delete the sealed refresh token and drop any in-memory Google token. */
  /** Delete the sealed refresh token, revoke it at the IdP (best effort), drop cached tokens. */
  async unlink(teamId: string, userId: string): Promise<void> {
    const rec = await this.getLinked(teamId, userId);
    await this.opts.store.delete(identityKey(teamId, userId));
    if (rec) {
      this.cache.delete(this.cacheKey(rec));
      try {
        await this.opts.oidc.revoke(
          await this.opts.vault.open(rec.refresh, userAad(teamId, userId)),
        );
      } catch {
        /* revocation is best effort; the sealed token is already deleted */
      }
    }
  }

  /** Cache entries are per link (re-linking or another instance's unlink yields a new key). */
  private cacheKey(rec: LinkedIdentity): string {
    return `${rec.teamId}:${rec.slackUserId}:${rec.linkedAt}:${rec.subject}`;
  }

  async resolve(input: ResolveInput): Promise<Resolved> {
    const linked = await this.getLinked(input.teamId, input.userId);
    const decision = decidePrincipal({
      policy: input.policy,
      linked: linked !== undefined,
      offlineGranted: linked?.allowUnattended ?? false,
      ...(input.requested ? { requested: input.requested } : {}),
      unattended: input.unattended,
      externallyShared: input.externallyShared,
      serviceConfigured: this.serviceConfigured,
    });
    if (!decision.ok) return { ok: false, decision };

    if (decision.kind === 'service') {
      const svc = this.opts.service!;
      const principal: Principal = {
        kind: 'service',
        serviceAccount: svc.serviceAccount,
        onBehalfOf: { teamId: input.teamId, slackUserId: input.userId },
      };
      return {
        ok: true,
        principal,
        tokens: svc.tokens,
        identity: principalId(principal),
        ...(decision.coerced ? { notice: decision.coerced } : {}),
      };
    }

    const rec = linked!;
    const principal: Principal = {
      kind: 'user',
      teamId: rec.teamId,
      slackUserId: rec.slackUserId,
      subject: rec.subject,
      email: rec.email,
      provider: rec.provider,
    };
    return { ok: true, principal, tokens: this.userTokens(rec), identity: principalId(principal) };
  }

  private userTokens(rec: LinkedIdentity): TokenSource {
    const key = this.cacheKey(rec);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // LRU touch
      return hit;
    }
    const source =
      rec.provider === 'google'
        ? new GoogleUserTokenSource(async () => {
            const t = await this.refresh(rec);
            return { accessToken: t.access_token, expiresInSeconds: t.expires_in ?? 3600 };
          }, this.now)
        : new WifTokenClient(
            { getIdToken: async () => this.freshIdToken(rec) },
            this.opts.wif!,
            this.fetchImpl,
            this.now,
          );
    this.cache.set(key, source);
    const max = this.opts.maxCachedUsers ?? 500;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return source;
  }

  private async freshIdToken(rec: LinkedIdentity): Promise<string> {
    const t = await this.refresh(rec);
    if (!t.id_token) throw new IdentityRevokedError();
    const claims = this.opts.oidc.validateIdToken(t.id_token);
    // The refreshed identity must be the one that was linked — never a different subject.
    if (claims.sub !== rec.subject) {
      await this.unlink(rec.teamId, rec.slackUserId);
      throw new IdentityRevokedError();
    }
    return t.id_token;
  }

  private async refresh(rec: LinkedIdentity) {
    const aad = userAad(rec.teamId, rec.slackUserId);
    // Re-read: another instance may have rotated the refresh token since this record was cached.
    // A deleted record means the user disconnected: never fall back to the stale copy (M4).
    const current = await this.getLinked(rec.teamId, rec.slackUserId);
    if (!current || current.subject !== rec.subject) {
      this.cache.delete(this.cacheKey(rec));
      throw new IdentityRevokedError();
    }
    let refreshToken: string;
    try {
      refreshToken = await this.opts.vault.open(current.refresh, aad);
    } catch {
      await this.unlink(rec.teamId, rec.slackUserId);
      throw new IdentityRevokedError();
    }
    let t;
    try {
      t = await this.opts.oidc.refresh(refreshToken);
    } catch (e) {
      if (
        e instanceof OidcError &&
        (e.code === 'invalid_grant' || e.status === 400 || e.status === 401)
      ) {
        await this.unlink(rec.teamId, rec.slackUserId);
        throw new IdentityRevokedError();
      }
      throw e;
    }
    if (t.refresh_token && t.refresh_token !== refreshToken) {
      // Write the rotated token only if the record is unchanged since we read it: a concurrent
      // disconnect must not be resurrected, and a concurrent rotation must not be clobbered.
      const latest = await this.getLinked(rec.teamId, rec.slackUserId);
      if (latest && latest.refresh.ct === current.refresh.ct) {
        await this.opts.store.set(identityKey(rec.teamId, rec.slackUserId), {
          ...latest,
          refresh: await this.opts.vault.seal(t.refresh_token, aad),
        });
      }
    }
    return t;
  }
}
