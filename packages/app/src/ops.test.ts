import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AgentEntry } from '@ge-slack/contracts';
import type { GeminiClientConfig } from '@ge-slack/gemini-client';
import { checkManifest, wiredEventsFromSource } from './manifest-check.js';
import { formatReport, googleError, runProbes, type ProbeContext } from './probe.js';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('manifests/slack-app.manifest.json', root), 'utf8'),
) as Record<string, unknown>;
const wiring = readFileSync(new URL('packages/app/src/wiring.ts', root), 'utf8');

describe('manifest check', () => {
  const facts = { wiredEvents: wiredEventsFromSource(wiring) };

  it('passes for the checked-in manifest and reads the wired events', () => {
    expect(facts.wiredEvents).toEqual(
      expect.arrayContaining(['app_mention', 'agent_session_stopped', 'message.im']),
    );
    expect(checkManifest(manifest, facts)).toEqual([]);
  });

  it('catches drift: missing events, scopes, attested steps; forbidden scopes', () => {
    const m = structuredClone(manifest) as {
      settings: { event_subscriptions: { bot_events: string[] } };
      oauth_config: { scopes: { bot: string[] } };
      functions: Record<string, { input_parameters: { required: string[] } }>;
    };
    m.settings.event_subscriptions.bot_events = m.settings.event_subscriptions.bot_events.filter(
      (e) => e !== 'app_context_changed',
    );
    m.oauth_config.scopes.bot = m.oauth_config.scopes.bot
      .filter((s) => s !== 'lists:write')
      .concat('team:read', 'channels:write');
    m.functions.ge_ask!.input_parameters.required = ['prompt'];
    expect(checkManifest(m, facts)).toEqual(
      expect.arrayContaining([
        'missing bot scope lists:write',
        'bot scope team:read must not be requested',
        'bot scope channels:write is not on the allow-list (manifest-check.ts)',
        'event app_context_changed is wired but not subscribed',
        'workflow step ge_ask must require its interactivity input',
      ]),
    );
  });
});

// ---------------------------------------------------------------- probes

const gemini: GeminiClientConfig = {
  assistant: { project: 'p1', location: 'eu', engine: 'eng' },
  plannerSkillMentions: [{ label: 'slack-command-planner', uri: 'planner' }],
};
const agents: AgentEntry[] = [
  {
    alias: 'research',
    title: 'Deep Research',
    kind: 'deep-research',
    agentId: 'deep_research',
    serviceAllowed: false,
  },
  {
    alias: 'triage',
    title: 'Triage',
    kind: 'a2a',
    agentId: '42',
    serviceAllowed: false,
    attestation: { sideEffects: 'confirms', identity: 'user-delegated', hostedIn: 'eu' },
  },
];
const sources = [
  {
    alias: 'rb',
    title: 'Runbooks',
    dataStore: 'projects/p1/locations/eu/collections/default_collection/dataStores/rb',
    serviceAllowed: true,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A scripted engine keyed by URL suffix; records every request. */
function fakeEngine(routes: Array<[RegExp, (body: Record<string, unknown>) => Response]>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') });
    const route = routes.find(([re]) => re.test(url));
    return route ? route[1](body) : json({ error: { status: 'NOT_FOUND', message: url } }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ctx = (fetchImpl: typeof fetch, over: Partial<ProbeContext> = {}): ProbeContext => ({
  gemini,
  sources,
  agents,
  tokens: { getAccessToken: async () => 'ya29.SECRET' },
  identity: 'user:probe',
  fetchImpl,
  ...over,
});

describe('live probes (against a scripted engine)', () => {
  it('reports pass/fail/skip with actionable detail and never prints the token', async () => {
    const { calls, fetchImpl } = fakeEngine([
      [
        /:streamAssist$/,
        (b) => {
          const agent = (b.agentsSpec as { agentSpecs?: Array<{ agentId: string }> } | undefined)
            ?.agentSpecs?.[0]?.agentId;
          if (agent === 'deep_research') {
            return json([
              {
                answer: {
                  replies: [
                    {
                      groundedContent: {
                        content: { text: '1. Plan' },
                        contentMetadata: { contentKind: 'RESEARCH_PLAN' },
                      },
                    },
                  ],
                },
                sessionInfo: { session: 'projects/1/sessions/5' },
              },
            ]);
          }
          if (String((b.query as { text: string }).text).includes('mention://')) {
            return json([
              { answer: { replies: [{ groundedContent: { content: { text: '```plan\n```' } } }] } },
              { invokedSkills: [{ name: 'slack-command-planner' }] },
            ]);
          }
          return json([
            {
              answer: {
                replies: [{ groundedContent: { content: { text: 'ready' } } }],
              },
              connectorAuthErrors: b.toolsSpec
                ? [
                    {
                      dataConnector: 'projects/1/locations/eu/collections/jira-fed_1/dataConnector',
                    },
                  ]
                : undefined,
            },
          ]);
        },
      ],
      [/\/a2a\/v1\/card$/, () => json({ name: 'triage' })],
      [
        /\/a2a\/v1\/message:stream$/,
        () => json([{ message: { role: 'ROLE_AGENT', content: [{ text: 'pong' }] } }]),
      ],
      [
        /:listAvailableAgentViews$/,
        () =>
          json({
            agentViews: [
              { name: 'x/agents/deep_research', agentType: 'MANAGED' },
              { name: 'x/agents/planner', agentType: 'SKILL_AGENT' },
            ],
          }),
      ],
      [/\/engines\/eng$/, () => json({ dataStoreIds: ['rb'] })],
      [
        /dataConnector:invokeConnectorMcp$/,
        () => json({ error: { status: 'PERMISSION_DENIED', message: 'nope' } }, 403),
      ],
    ]);
    const results = await runProbes(ctx(fetchImpl, { connector: 'jira-fed_1', allowState: true }));
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(by['stream-assist']!.status).toBe('pass');
    expect(by['grounding']!.detail).toContain('connectorAuthErrors parsed: jira-fed_1');
    expect(by['skills:planner']!).toMatchObject({ status: 'pass' });
    expect(by['skills:command']!.status).toBe('skip');
    expect(by['agent:@research (deep-research)']!.detail).toContain('research plan returned');
    expect(by['agent:@triage (a2a)']!).toMatchObject({ status: 'pass' });
    // The A2A agent isn't visible to this identity → reported, not hidden.
    expect(by['agent-views']!).toMatchObject({ status: 'fail' });
    expect(by['agent-views']!.detail).toContain('@triage');
    expect(by['engine']!.status).toBe('pass');
    expect(by['connector-mcp']!.detail).toContain('PERMISSION_DENIED: nope');
    expect(by['connector-mcp']!.detail).toContain('missing IAM');

    // Every streamAssist request keeps the read-only posture; connector probe only lists tools.
    const assist = calls.filter((c) => c.url.endsWith(':streamAssist'));
    expect(
      assist.every((c) => (c.body.actionSpec as { actionDisabled?: boolean })?.actionDisabled),
    ).toBe(true);
    expect(calls.find((c) => c.url.includes('invokeConnectorMcp'))!.body.method).toBe('tools/list');
    expect(calls.every((c) => c.auth === 'Bearer ya29.SECRET')).toBe(true);
    const report = formatReport(results);
    expect(report).not.toContain('SECRET');
    expect(report).toMatch(/\d+ passed · 2 failed · 1 skipped/);
  });

  it('creates no state by default: no Deep Research session, no A2A task', async () => {
    const { calls, fetchImpl } = fakeEngine([[/\/a2a\/v1\/card$/, () => json({ name: 'triage' })]]);
    const results = await runProbes(ctx(fetchImpl), ['agents']);
    expect(results.map((r) => r.status)).toEqual(['skip', 'pass']);
    expect(results[1]!.detail).toContain('--allow-state');
    expect(calls.map((c) => c.url)).toEqual([expect.stringMatching(/\/a2a\/v1\/card$/)]);
    // Through an egress proxy, raw calls (the card too) are skipped, never sent around it.
    const proxied = await runProbes(
      ctx(fetchImpl, { gemini: { ...gemini, proxyUrl: 'https://proxy.example' } }),
      ['agents'],
    );
    expect(proxied[1]).toMatchObject({ status: 'skip' });
    expect(calls).toHaveLength(1);
  });

  it('turns a provider failure into one redacted line', async () => {
    const { fetchImpl } = fakeEngine([
      [
        /:streamAssist$/,
        () =>
          json(
            [{ error: { status: 'PERMISSION_DENIED', message: 'Bearer ya29.LEAK denied' } }],
            403,
          ),
      ],
    ]);
    const [r] = await runProbes(ctx(fetchImpl), ['stream-assist']);
    expect(r!.status).toBe('fail');
    expect(r!.detail).toContain('http_403');
    expect(r!.detail).not.toContain('LEAK');
    expect(googleError('not json\n‮at all')).toBe('not json at all');
  });
});
