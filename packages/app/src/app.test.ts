import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { buildContainer } from './container.js';
import { invocationFromComposer, onPolicySubmit, onSlash } from './handlers.js';
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
    if (method === 'users.info')
      return {
        ok: true,
        user: { is_admin: args.user === 'U0ADMIN', profile: { email: 'alex@acme.com' } },
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
    ).toThrow(/memory/);
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
    });
  });
});

describe('http routes', () => {
  it('cron tick requires the shared secret', async () => {
    const { c } = await container();
    const tick = routes(c).find((r) => r.path === '/cron/tick')!;
    const bad = fakeRes();
    tick.handler(
      { headers: { 'x-ge-cron-secret': 'nope' } } as unknown as IncomingMessage,
      bad.res,
    );
    expect(bad.r.status).toBe(401);
    const good = fakeRes();
    tick.handler(
      { headers: { 'x-ge-cron-secret': ENV.GE_CRON_SECRET } } as unknown as IncomingMessage,
      good.res,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(good.r.status).toBe(200);
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
