import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryStore } from '@ge-slack/identity';
import {
  ACTIONS,
  CALLBACKS,
  WORKFLOW_STEPS,
  type SlackApi,
  type SlackApiResponse,
} from '@ge-slack/slack-bridge';
import { loadConfig } from './config.js';
import { buildContainer, type Container } from './container.js';
import { GoogleIdTokenVerifier } from './google-id-token.js';
import {
  invocationFromComposer,
  onPolicySubmit,
  onSlash,
  rememberFromMessage,
} from './handlers.js';
import { routes } from './wiring.js';

const ENV = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'x'.repeat(32),
  SLACK_TEAM_ID: 'T0ACME',
  SLACK_TEAM_DOMAIN: 'acme',
  GE_PROJECT: 'p1',
  GE_LOCATION: 'eu',
  GE_ENGINE: 'eng',
  IDP_ISSUER: 'https://login.acme.example',
  IDP_CLIENT_ID: 'cid',
  PUBLIC_BASE_URL: 'https://bot.acme.example',
  WIF_POOL_ID: 'pool',
  WIF_PROVIDER_ID: 'acme',
  GE_SERVICE_MODE: 'impersonate',
  GE_SERVICE_ACCOUNT: 'ge-bot@p1.iam.gserviceaccount.com',
  GE_SLACK_VAULT_KEY: randomBytes(32).toString('base64'),
  GE_CRON_SECRET: 'c'.repeat(32),
  GE_SOURCES_JSON: JSON.stringify([
    {
      alias: 'runbooks',
      title: 'Runbooks',
      dataStore: 'projects/p1/locations/eu/collections/default_collection/dataStores/rb',
      serviceAllowed: true,
    },
  ]),
};

class FakeSlack implements SlackApi {
  calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  async call(method: string, args: Record<string, unknown>): Promise<SlackApiResponse> {
    this.calls.push({ method, args });
    if (method === 'conversations.info') return { ok: true, channel: { name: 'eng' } };
    if (method === 'conversations.members') return { ok: true, members: ['U0ALEX'] };
    if (method === 'chat.getPermalink') {
      return { ok: true, permalink: 'https://acme.slack.com/archives/C0ENG/p1700000000000100' };
    }
    if (method === 'users.info')
      return {
        ok: true,
        user: {
          is_admin: args.user === 'U0ADMIN',
          team_id: ENV.SLACK_TEAM_ID,
          profile: { email: 'alex@acme.com' },
        },
      };
    return { ok: true };
  }
}

async function container() {
  const api = new FakeSlack();
  const posts: Array<Record<string, unknown>> = [];
  const idpFetch = (async (url: string) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer: ENV.IDP_ISSUER,
        authorization_endpoint: `${ENV.IDP_ISSUER}/authorize`,
        token_endpoint: `${ENV.IDP_ISSUER}/token`,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const c = await buildContainer(loadConfig(ENV as unknown as NodeJS.ProcessEnv), {
    api,
    kv: new MemoryStore(),
    fetchImpl: idpFetch,
    postResponse: async (_u, b) => {
      posts.push(b);
    },
  });
  return { c, api, posts };
}

function fakeRes() {
  const r = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    writeHead(s: number, h?: Record<string, unknown>) {
      r.status = s;
      r.headers = h ?? {};
      return res;
    },
    end(b?: string) {
      r.body = b ?? '';
    },
  } as unknown as ServerResponse;
  return { r, res };
}

describe('config', () => {
  it('FAQ needs its own curator account, a residency-pinned data store and stewards', () => {
    const env = (o: Record<string, string>) => ({ ...ENV, ...o }) as unknown as NodeJS.ProcessEnv;
    const faq = {
      GE_FEATURES: '+faq',
      GE_FAQ_DATASTORE: 'projects/p1/locations/eu/collections/default_collection/dataStores/faq',
      GE_FAQ_CURATOR_SERVICE_ACCOUNT: 'faq-curator@p1.iam.gserviceaccount.com',
      GE_FAQ_STEWARDS_CHANNEL: 'C0STW',
      GE_FAQ_STEWARDS: 'U0STEW',
      GE_FAQ_CHANNELS: 'C0ENG',
    };
    expect(loadConfig(env(faq)).features.has('faq')).toBe(true);
    expect(() => loadConfig(env({ ...faq, GE_FAQ_STEWARDS: '' }))).toThrow(/GE_FAQ/);
    expect(() =>
      loadConfig(
        env({
          ...faq,
          GE_FAQ_DATASTORE:
            'projects/p1/locations/us/collections/default_collection/dataStores/faq',
        }),
      ),
    ).toThrow(/residency/);
    expect(() => loadConfig(env({ GE_FEATURES: '+brief,-delegation' }))).toThrow(/delegation/);
  });

  it('licence assignment is pinned to GE_LOCATION and needs an approvals channel', () => {
    const env = (o: Record<string, string>) => ({ ...ENV, ...o }) as unknown as NodeJS.ProcessEnv;
    expect(() =>
      loadConfig(
        env({
          GE_LICENCE_CONFIG: 'projects/p1/locations/us/licenseConfigs/std',
          GE_LICENCE_REQUESTS_CHANNEL: 'C0LIC',
        }),
      ),
    ).toThrow(/residency/);
    expect(() =>
      loadConfig(env({ GE_LICENCE_CONFIG: 'projects/p1/locations/eu/licenseConfigs/std' })),
    ).toThrow(/GE_LICENCE_REQUESTS_CHANNEL/);
    expect(() => loadConfig(env({ GE_LICENCE_APPROVERS: 'U1,not-a-user' }))).toThrow();
    // Assignment needs its own admin-plane SA, never the licensed service account (M3).
    expect(() =>
      loadConfig(
        env({
          GE_LICENCE_CONFIG: 'projects/p1/locations/eu/licenseConfigs/std',
          GE_LICENCE_REQUESTS_CHANNEL: 'C0LIC',
        }),
      ),
    ).toThrow(/GE_LICENCE_ADMIN_SERVICE_ACCOUNT/);
    expect(() =>
      loadConfig(
        env({
          GE_LICENCE_CONFIG: 'projects/other/locations/eu/licenseConfigs/std',
          GE_LICENCE_ADMIN_SERVICE_ACCOUNT: 'lic-admin@p.iam.gserviceaccount.com',
          GE_LICENCE_REQUESTS_CHANNEL: 'C0LIC',
        }),
      ),
    ).toThrow(/GE_PROJECT/);
    const ok = loadConfig(
      env({
        GE_LICENCE_CONFIG: 'projects/p1/locations/eu/licenseConfigs/std',
        GE_LICENCE_ADMIN_SERVICE_ACCOUNT: 'lic-admin@p.iam.gserviceaccount.com',
        GE_LICENCE_REQUESTS_CHANNEL: 'C0LIC',
        GE_LICENCE_APPROVERS: 'U0A, U0B',
      }),
    );
    expect(ok.features.has('licences')).toBe(true);
  });

  it('fails fast without a residency pin, vault key, or WIF for OIDC', () => {
    expect(() => loadConfig({ ...ENV, GE_LOCATION: '' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /GE_LOCATION/,
    );
    expect(() =>
      loadConfig({ ...ENV, GE_SLACK_VAULT_KEY: 'short' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/VAULT/);
    expect(() =>
      loadConfig({ ...ENV, WIF_POOL_ID: undefined } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Workforce/);
    expect(() =>
      loadConfig({ ...ENV, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/static key/);
    const kms = {
      ...ENV,
      GE_SLACK_VAULT_KEY: undefined,
      GE_SLACK_KMS_KEY: 'projects/p/locations/eu/keyRings/r/cryptoKeys/k',
      GE_SLACK_WRAPPED_KEYS: 'k1=abc',
      NODE_ENV: 'production',
    };
    const load = (e: Record<string, unknown>) => () =>
      loadConfig(e as unknown as NodeJS.ProcessEnv);
    expect(load(kms)).toThrow(/memory/);
    expect(load({ ...kms, GE_STORE: 'firestore', GE_EMAIL_BINDING: 'off' })).toThrow(/enforce/);
    // Production cron is OIDC-only: no shared secret in scheduler config.
    expect(load({ ...kms, GE_STORE: 'firestore' })).toThrow(/GE_CRON_INVOKER/);
    expect(
      load({ ...kms, GE_STORE: 'firestore', GE_CRON_INVOKER: 'cron@p1.iam.gserviceaccount.com' }),
    ).not.toThrow();
  });
  it('loads the @agent catalog and refuses aliases that collide with sources or keywords', () => {
    const agent = (alias: string) =>
      JSON.stringify([{ alias, title: 'A', kind: 'assistant', agentId: '123' }]);
    const load = (extra: Record<string, unknown>) =>
      loadConfig({ ...ENV, ...extra } as unknown as NodeJS.ProcessEnv);
    expect(load({ GE_AGENTS_JSON: agent('helpdesk') }).agents[0]!.alias).toBe('helpdesk');
    expect(() => load({ GE_AGENTS_JSON: agent('web') })).toThrow(/collides/);
    const firstSource = (JSON.parse(String(ENV.GE_SOURCES_JSON)) as Array<{ alias: string }>)[0]!;
    expect(() => load({ GE_AGENTS_JSON: agent(firstSource.alias) })).toThrow(/collides/);
    expect(() => load({ GE_APP_URL: 'http://ge.example' })).toThrow(/https/);
    const a2a = (hostedIn: string) =>
      JSON.stringify([
        {
          alias: 'triage',
          title: 'T',
          kind: 'a2a',
          agentId: '9',
          attestation: { sideEffects: 'confirms', identity: 'user-delegated', hostedIn },
        },
      ]);
    expect(() => load({ GE_AGENTS_JSON: a2a('us') })).toThrow(/outside GE_LOCATION/);
    expect(load({ GE_AGENTS_JSON: a2a(String(ENV.GE_LOCATION)) }).agents).toHaveLength(1);
  });
});

describe('slash command', () => {
  it('unlinked users get a private connect prompt via response_url', async () => {
    const { c, posts } = await container();
    await onSlash(c, {
      teamId: 'T0ACME',
      userId: 'U0ALEX',
      channelId: 'C0ENG',
      text: 'summarize --since 7d',
      responseUrl: 'https://hooks.slack.com/x',
      triggerId: 't',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ response_type: 'ephemeral' });
    expect(JSON.stringify(posts[0])).toContain('Connect with your company SSO');
    expect(JSON.stringify(posts[0])).toContain('login.acme.example/authorize');
  });

  it('bare /gemini opens the composer modal', async () => {
    const { c, api } = await container();
    await onSlash(c, {
      teamId: 'T0ACME',
      userId: 'U0ALEX',
      channelId: 'C0ENG',
      text: '',
      responseUrl: 'https://hooks.slack.com/x',
      triggerId: 'trig',
    });
    const open = api.calls.find((x) => x.method === 'views.open');
    expect(open?.args.trigger_id).toBe('trig');
    expect(JSON.stringify(open?.args.view)).toContain(CALLBACKS.composer);
  });

  it('help is answered privately without calling Gemini', async () => {
    const { c, posts } = await container();
    await onSlash(c, {
      teamId: 'T0ACME',
      userId: 'U0ALEX',
      channelId: 'C0ENG',
      text: 'help',
      responseUrl: 'https://hooks.slack.com/x',
      triggerId: 't',
    });
    expect(JSON.stringify(posts[0])).toContain('automate');
  });
});

describe('composer', () => {
  it('maps modal values to a typed invocation', () => {
    const inv = invocationFromComposer(
      {
        verb: { v: { selected_option: { value: 'draft' } } },
        scope: { v: { selected_option: { value: 'thread' } } },
        sources: { v: { selected_options: [{ value: 'unit' }, { value: 'runbooks' }] } },
        instruction: { v: { value: 'a reply' } },
        runas: { v: { selected_option: { value: 'service' } } },
        visibility: { v: { selected_option: { value: 'public' } } },
      },
      { c: 'C0ENG', t: '1700000000.000100' },
    );
    expect(inv).toMatchObject({
      verb: 'draft',
      scope: { kind: 'thread', channel: 'C0ENG', ts: '1700000000.000100' },
      grounds: [{ kind: 'unit' }, { kind: 'alias', alias: 'runbooks' }],
      instruction: 'a reply',
      flags: { as: 'service', visibility: 'public' },
    });
  });
});

describe('admin policy', () => {
  it('only admins can change policy; Slack Connect channels must be service-only', async () => {
    const { c } = await container();
    const values = {
      channel: { v: { selected_conversation: 'C0ENG' } },
      identity: { v: { selected_option: { value: 'user-preferred' } } },
      flags: { v: { selected_options: [{ value: 'read' }] } },
      grounds: { v: { selected_options: [{ value: 'runbooks' }] } },
    } as unknown as Parameters<typeof onPolicySubmit>[2];
    expect(await onPolicySubmit(c, 'U0ALEX', values)).toMatch(/admins/);
    expect(await onPolicySubmit(c, 'U0ADMIN', values)).toBeUndefined();
    expect(await c.workspace.channelPolicy('T0ACME', 'C0ENG')).toEqual({
      identity: 'user-preferred',
      serviceGrounds: ['runbooks'],
      serviceMayRead: true,
      autoApply: false,
      suggest: false,
    });
  });
});

describe('http routes', () => {
  const tickWith = async (c: Container, headers: Record<string, string>) => {
    const tick = routes(c).find((r) => r.path === '/cron/tick')!;
    const out = fakeRes();
    tick.handler({ headers } as unknown as IncomingMessage, out.res);
    await new Promise((r) => setTimeout(r, 20));
    return out.r.status;
  };

  it('cron tick (dev) requires the shared secret', async () => {
    const { c } = await container();
    expect(await tickWith(c, { 'x-ge-cron-secret': 'nope' })).toBe(401);
    expect(await tickWith(c, { 'x-ge-cron-secret': String(ENV.GE_CRON_SECRET) })).toBe(200);
  });

  it('cron tick (production) accepts only a Google ID token for the invoker', async () => {
    const { c } = await container();
    const invoker = 'cron@p1.iam.gserviceaccount.com';
    const google = fakeGoogle();
    c.cfg.GE_CRON_INVOKER = invoker;
    c.cronVerifier = new GoogleIdTokenVerifier(google.fetchImpl, () => NOW_MS);
    const audience = `${String(ENV.PUBLIC_BASE_URL).replace(/\/$/, '')}/cron/tick`;
    const bearer = (claims: Record<string, unknown>, key = google.key) => ({
      authorization: `Bearer ${google.sign({ ...goodClaims(invoker, audience), ...claims }, key)}`,
    });
    expect(await tickWith(c, bearer({}))).toBe(200);
    // Once an invoker is configured the shared secret no longer works.
    expect(await tickWith(c, { 'x-ge-cron-secret': String(ENV.GE_CRON_SECRET) })).toBe(401);
    expect(await tickWith(c, bearer({ aud: 'https://elsewhere/cron/tick' }))).toBe(401);
    expect(await tickWith(c, bearer({ email: 'other@p1.iam.gserviceaccount.com' }))).toBe(401);
    expect(await tickWith(c, bearer({ email_verified: false }))).toBe(401);
    expect(await tickWith(c, bearer({ exp: NOW_MS / 1000 - 3600 }))).toBe(401);
    expect(await tickWith(c, bearer({ iss: 'https://evil.example' }))).toBe(401);
    expect(await tickWith(c, bearer({}, google.otherKey))).toBe(401);
    const [h, p] = google.sign(goodClaims(invoker, audience)).split('.');
    expect(await tickWith(c, { authorization: `Bearer ${h}.${p}.` })).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    expect(await tickWith(c, { authorization: `Bearer ${none}.${p}.` })).toBe(401);
  });

  it('oauth callback rejects unknown state with an escaped page', async () => {
    const { c } = await container();
    const cb = routes(c).find((r) => r.path === '/oauth/callback')!;
    const out = fakeRes();
    cb.handler(
      { url: '/oauth/callback?state=<script>&code=x' } as unknown as IncomingMessage,
      out.res,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(out.r.status).toBe(400);
    expect(out.r.body).not.toContain('<script>');
    expect(out.r.headers['Content-Security-Policy']).toBeDefined();
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../../manifests/slack-app.manifest.json', import.meta.url), 'utf8'),
  );
  it('declares every shortcut and workflow step the app handles', () => {
    const shortcutIds = manifest.features.shortcuts
      .map((s: { callback_id: string }) => s.callback_id)
      .sort();
    const handled = Object.values(CALLBACKS)
      .filter((id) => id.startsWith('ge_msg_') || id === 'ge_global_new')
      .sort();
    expect(shortcutIds).toEqual(handled);
    expect(Object.keys(manifest.functions).sort()).toEqual(Object.values(WORKFLOW_STEPS).sort());
    expect(manifest.features.slash_commands[0].should_escape).toBe(true);
  });
  it('requests no user scopes and no admin/broad scopes', () => {
    expect(manifest.oauth_config.scopes.user).toBeUndefined();
    const bot: string[] = manifest.oauth_config.scopes.bot;
    expect(
      bot.some(
        (s) => s.startsWith('admin') || s === 'chat:write.public' || s === 'channels:manage',
      ),
    ).toBe(false);
  });
  it('uses action ids that exist', () => {
    expect(ACTIONS.approve).toBe('ge_approve');
  });
});

describe('agent DM context', () => {
  const base = {
    verb: 'summarize' as const,
    inferredVerb: false,
    grounds: [],
    people: [],
    from: [],
    instruction: '',
    flags: {},
  };
  it('uses the viewed channel only when no explicit scope was given', async () => {
    const { applyViewingContext, viewedChannel } = await import('./handlers.js');
    const viewing = viewedChannel({
      entities: [{ type: 'slack#/types/channel_id', value: 'C0ENG', team_id: 'T0ACME' }],
    });
    expect(viewing).toBe('C0ENG');
    expect(applyViewingContext(base, viewing).scope).toEqual({ kind: 'channel', channel: 'C0ENG' });
    expect(applyViewingContext({ ...base, scope: { kind: 'channel' } }, viewing).scope).toEqual({
      kind: 'channel',
      channel: 'C0ENG',
    });
    expect(
      applyViewingContext({ ...base, scope: { kind: 'channel', channel: 'C0OTHER' } }, viewing)
        .scope,
    ).toEqual({ kind: 'channel', channel: 'C0OTHER' });
    expect(
      applyViewingContext({ ...base, verb: 'ask', instruction: 'what is WIF?' }, viewing).scope,
    ).toBeUndefined();
    expect(
      applyViewingContext(
        { ...base, verb: 'ask', instruction: 'what happened here today?' },
        viewing,
      ).scope,
    ).toBeDefined();
    expect(applyViewingContext(base, 'D0DM').scope).toBeUndefined();
  });
  it('suggests at most four prompts that parse in the DM', async () => {
    const { suggestedPrompts } = await import('./handlers.js');
    const { parseCommand } = await import('@ge-slack/contracts');
    for (const prompts of [
      suggestedPrompts('C0ENG', 'eng'),
      suggestedPrompts(undefined, undefined),
    ]) {
      expect(prompts.length).toBeLessThanOrEqual(4);
      for (const p of prompts) expect(parseCommand(p.message).kind).not.toBe('error');
    }
  });
});

const NOW_MS = Date.UTC(2026, 9, 6, 6, 0, 0);

function goodClaims(email: string, aud: string): Record<string, unknown> {
  const now = NOW_MS / 1000;
  return {
    iss: 'https://accounts.google.com',
    aud,
    email,
    email_verified: true,
    iat: now - 10,
    exp: now + 3590,
  };
}

/** Google's JWKS endpoint with one signing key (k1), plus a key Google never published. */
function fakeGoogle() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetchImpl = (async () =>
    Response.json(
      { keys: [jwk] },
      { headers: { 'cache-control': 'public, max-age=3600' } },
    )) as unknown as typeof fetch;
  const sign = (claims: Record<string, unknown>, k = key) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString(
      'base64url',
    );
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), k.privateKey).toString(
      'base64url',
    );
    return `${h}.${p}.${sig}`;
  };
  return { fetchImpl, sign, key, otherKey };
}

describe('channel memory (app)', () => {
  it('"Remember this" stores the message with a link back and its author', async () => {
    const { c, api } = await container();
    await rememberFromMessage(c, {
      teamId: String(ENV.SLACK_TEAM_ID),
      userId: 'U0ALEX',
      channelId: 'C0ENG',
      messageTs: '1700000000.000100',
      text: 'Rollback runbook lives in <!channel> the wiki',
      sourceUser: 'U0MAYA',
    });
    const [note] = await c.stores.notes(String(ENV.SLACK_TEAM_ID), 'C0ENG');
    expect(note).toMatchObject({
      text: 'Rollback runbook lives in the wiki',
      author: 'U0ALEX',
      sourceUser: 'U0MAYA',
      permalink: 'https://acme.slack.com/archives/C0ENG/p1700000000000100',
    });
    expect(api.calls.some((x) => x.method === 'chat.getPermalink')).toBe(true);
  });
});
