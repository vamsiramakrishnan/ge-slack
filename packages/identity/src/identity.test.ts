import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from './store.js';
import { StaticKeyProvider, TokenVault, userAad } from './vault.js';
import { OidcClient } from './oidc.js';
import { AccountLinker, identityKey, type LinkedIdentity } from './linking.js';
import { IdentityBroker, IdentityRevokedError } from './broker.js';

const ISSUER = 'https://login.acme.example';
const key = randomBytes(32).toString('base64');
const vault = () => new TokenVault(new StaticKeyProvider('k1', { k1: key }));

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
}

/** A fake IdP + STS. Records refresh tokens it has issued so rotation can be asserted. */
function fakeIdp(
  opts: { email?: string; sub?: string; refreshSub?: string; refreshError?: string } = {},
) {
  const calls: string[] = [];
  let nonce = '';
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      });
    }
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code_verifier')).toBeTruthy();
        return Response.json({
          access_token: 'at',
          refresh_token: 'rt-1',
          id_token: jwt({
            iss: ISSUER,
            aud: 'cid',
            sub: opts.sub ?? 'sub-1',
            exp,
            nonce,
            email: opts.email ?? 'alex@acme.com',
          }),
        });
      }
      if (opts.refreshError) return Response.json({ error: opts.refreshError }, { status: 400 });
      return Response.json({
        access_token: 'at2',
        refresh_token: 'rt-2',
        id_token: jwt({
          iss: ISSUER,
          aud: 'cid',
          sub: opts.refreshSub ?? opts.sub ?? 'sub-1',
          exp,
        }),
      });
    }
    if (url === 'https://sts.googleapis.com/v1/token') {
      return Response.json({ access_token: 'google-at', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fetchImpl, calls, setNonce: (n: string) => (nonce = n) };
}

async function link(
  idp: ReturnType<typeof fakeIdp>,
  store: MemoryStore,
  slackEmail = 'alex@acme.com',
) {
  const oidc = new OidcClient(
    {
      kind: 'oidc',
      issuer: ISSUER,
      clientId: 'cid',
      redirectUri: 'https://bot.acme.example/oauth/callback',
      displayName: 'Acme SSO',
    },
    idp.fetchImpl as unknown as typeof fetch,
  );
  const linker = new AccountLinker(store, vault(), oidc);
  const url = new URL(await linker.start({ teamId: 'T1', slackUserId: 'U0ALEX', resumeId: 'r1' }));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toContain('offline_access');
  idp.setNonce(url.searchParams.get('nonce')!);
  const state = url.searchParams.get('state')!;
  const outcome = await linker.complete(state, 'code', async () => slackEmail);
  return { outcome, state, linker, oidc };
}

describe('TokenVault', () => {
  it('round-trips and refuses a different user AAD or a tampered blob', async () => {
    const v = vault();
    const sealed = await v.seal('secret', userAad('T1', 'U1'));
    expect(JSON.stringify(sealed)).not.toContain('secret');
    expect(await v.open(sealed, userAad('T1', 'U1'))).toBe('secret');
    await expect(v.open(sealed, userAad('T1', 'U2'))).rejects.toThrow();
    await expect(
      v.open({ ...sealed, ct: Buffer.from('xxxxxx').toString('base64') }, userAad('T1', 'U1')),
    ).rejects.toThrow();
  });
  it('rejects short keys', () => {
    expect(() => new StaticKeyProvider('k', { k: Buffer.alloc(16).toString('base64') })).toThrow();
  });
});

describe('AccountLinker', () => {
  it('links with PKCE + nonce, seals the refresh token, and consumes state once', async () => {
    const store = new MemoryStore();
    const idp = fakeIdp();
    const { outcome, state, linker } = await link(idp, store);
    expect(outcome).toEqual({
      ok: true,
      teamId: 'T1',
      slackUserId: 'U0ALEX',
      email: 'alex@acme.com',
      resumeId: 'r1',
    });
    const rec = await store.get<LinkedIdentity>(identityKey('T1', 'U0ALEX'));
    expect(rec?.subject).toBe('sub-1');
    expect(JSON.stringify(rec)).not.toContain('rt-1');
    const again = await linker.complete(state, 'code', async () => 'alex@acme.com');
    expect(again.ok === false && again.reason).toBe('expired-state');
  });

  it('fails closed when the IdP email does not match Slack', async () => {
    const store = new MemoryStore();
    const { outcome } = await link(fakeIdp({ email: 'mallory@acme.com' }), store);
    expect(outcome.ok === false && outcome.reason).toBe('email-mismatch');
    expect(await store.get(identityKey('T1', 'U0ALEX'))).toBeUndefined();
  });
});

describe('IdentityBroker', () => {
  const service = {
    serviceAccount: 'ge-bot@p1.iam.gserviceaccount.com',
    tokens: { getAccessToken: async () => 'svc' },
  };

  async function setup(idpOpts: Parameters<typeof fakeIdp>[0] = {}) {
    const store = new MemoryStore();
    const idp = fakeIdp(idpOpts);
    const { oidc } = await link(idp, store);
    const broker = new IdentityBroker({
      store,
      vault: vault(),
      oidc,
      wif: { poolId: 'pool', providerId: 'acme' },
      service,
      fetchImpl: idp.fetchImpl as unknown as typeof fetch,
    });
    return { store, idp, broker };
  }

  const base = {
    teamId: 'T1',
    userId: 'U0ALEX',
    policy: 'user-only' as const,
    unattended: false,
    externallyShared: false,
  };

  it('resolves a linked user to a WIF token source and rotates the refresh token', async () => {
    const { broker, store } = await setup();
    const r = await broker.resolve(base);
    expect(r.ok && r.principal).toMatchObject({ kind: 'user', email: 'alex@acme.com' });
    expect(r.ok && r.identity).toBe('user:alex@acme.com');
    if (!r.ok) return;
    expect(await r.tokens.getAccessToken()).toBe('google-at');
    const rec = await store.get<LinkedIdentity>(identityKey('T1', 'U0ALEX'));
    expect(await vault().open(rec!.refresh, userAad('T1', 'U0ALEX'))).toBe('rt-2');
  });

  it('drops the link when the IdP revokes the refresh token', async () => {
    const { broker, store } = await setup({ refreshError: 'invalid_grant' });
    const r = await broker.resolve(base);
    if (!r.ok) throw new Error('expected ok');
    await expect(r.tokens.getAccessToken()).rejects.toBeInstanceOf(IdentityRevokedError);
    expect(await store.get(identityKey('T1', 'U0ALEX'))).toBeUndefined();
  });

  it('refuses a refreshed id_token for a different subject', async () => {
    const { broker } = await setup({ refreshSub: 'someone-else' });
    const r = await broker.resolve(base);
    if (!r.ok) throw new Error('expected ok');
    await expect(r.tokens.getAccessToken()).rejects.toBeInstanceOf(IdentityRevokedError);
  });

  it('uses the service identity with on-behalf-of attribution when policy says so', async () => {
    const { broker } = await setup();
    const r = await broker.resolve({ ...base, policy: 'service-only' });
    expect(r.ok && r.principal).toEqual({
      kind: 'service',
      serviceAccount: 'ge-bot@p1.iam.gserviceaccount.com',
      onBehalfOf: { teamId: 'T1', slackUserId: 'U0ALEX' },
    });
    expect(r.ok && (await r.tokens.getAccessToken())).toBe('svc');
  });

  it('asks unlinked users to connect', async () => {
    const { broker } = await setup();
    const r = await broker.resolve({ ...base, userId: 'U0NEW' });
    expect(!r.ok && r.decision.reason).toBe('needs-link');
  });
});

describe('identity regressions', () => {
  it('a disconnect during an in-flight refresh is not resurrected, and the token is revoked (M4)', async () => {
    const store = new MemoryStore();
    const idp = fakeIdp();
    const { oidc } = await link(idp, store);
    const broker = new IdentityBroker({
      store,
      vault: vault(),
      oidc,
      wif: { poolId: 'pool', providerId: 'acme' },
      fetchImpl: idp.fetchImpl as unknown as typeof fetch,
    });
    const r = await broker.resolve({
      teamId: 'T1',
      userId: 'U0ALEX',
      policy: 'user-only',
      unattended: false,
      externallyShared: false,
    });
    if (!r.ok) throw new Error('expected ok');
    await broker.unlink('T1', 'U0ALEX');
    await expect(r.tokens.getAccessToken()).rejects.toBeInstanceOf(IdentityRevokedError);
    expect(await store.get(identityKey('T1', 'U0ALEX'))).toBeUndefined();
  });

  it('refuses an explicitly unverified email for binding (L1)', async () => {
    const { claimEmail } = await import('./oidc.js');
    expect(
      claimEmail({
        iss: 'i',
        sub: 's',
        aud: 'a',
        exp: 1,
        email: 'x@acme.com',
        email_verified: false,
      }),
    ).toBeUndefined();
    expect(claimEmail({ iss: 'i', sub: 's', aud: 'a', exp: 1, email: 'X@acme.com' })).toBe(
      'x@acme.com',
    );
  });
});
