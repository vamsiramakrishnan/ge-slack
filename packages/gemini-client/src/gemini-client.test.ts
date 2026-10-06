import { describe, expect, it, vi } from 'vitest';
import type { AssistEvent } from '@ge-slack/contracts';
import {
  StreamAssistClient,
  buildStreamAssistRequest,
  collectStream,
  type AssistTurn,
} from './stream-assist.js';
import { A2aClient, GeminiEnterpriseClient } from './a2a.js';
import {
  a2aStreamUrl,
  discoveryEngineHost,
  streamAssistUrl,
  type GeminiClientConfig,
} from './config.js';
import { WifTokenClient } from './wif.js';
import { ImpersonatedTokenSource, MetadataServerTokenSource } from './service-account.js';
import type { TokenSource } from './token-source.js';

const cfg: GeminiClientConfig = {
  assistant: { project: 'p1', location: 'eu', engine: 'eng' },
  commandSkills: [
    'projects/p1/locations/eu/collections/default_collection/engines/eng/assistants/default_assistant/agents/123',
  ],
  commandSkillMentions: [{ label: 'slack-surface-commander', uri: '123' }],
};

function streamBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const text = '[' + frames.map((f) => JSON.stringify(f)).join(',\n') + ']';
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      // Split mid-object to exercise the incremental parser.
      c.enqueue(bytes.slice(0, 17));
      c.enqueue(bytes.slice(17));
      c.close();
    },
  });
}

const tokens = (): TokenSource & { invalidate: ReturnType<typeof vi.fn> } => ({
  getAccessToken: vi.fn(async () => 'tok'),
  invalidate: vi.fn(),
});

async function all(gen: AsyncIterable<AssistEvent>): Promise<AssistEvent[]> {
  const out: AssistEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('config', () => {
  it('pins regional hosts and refuses an empty location', () => {
    expect(discoveryEngineHost('eu')).toBe('https://discoveryengine.eu.rep.googleapis.com');
    expect(() => discoveryEngineHost('')).toThrow(/residency/);
    expect(streamAssistUrl(cfg)).toBe(
      'https://discoveryengine.eu.rep.googleapis.com/v1alpha/projects/p1/locations/eu/collections/default_collection/engines/eng/assistants/default_assistant:streamAssist',
    );
    expect(() => streamAssistUrl({ ...cfg, proxyUrl: 'http://proxy.example.com' })).toThrow(
      /https/,
    );
  });
});

describe('buildStreamAssistRequest', () => {
  it('mounts route skills with a mention marker and grounds on data stores', () => {
    const body = buildStreamAssistRequest(
      {
        text: 'do it',
        route: 'command',
        sessionless: true,
        identity: 'x',
        dataStores: ['ds1'],
        notebookId: 'nb"1',
      },
      cfg,
    );
    expect(body).toEqual({
      query: { text: '[slack-surface-commander](mention://?uri=123) do it' },
      actionSpec: { actionDisabled: true },
      agentsSpec: { agentSpecs: [{ agentId: '123' }] },
      toolsSpec: {
        vertexAiSearchSpec: {
          filter: 'notebookId: ANY("nb1")',
          dataStoreSpecs: [{ dataStore: 'ds1' }],
        },
      },
    });
  });
  it('chat turns mount nothing and keep the session', () => {
    expect(
      buildStreamAssistRequest(
        { text: 'hi', route: 'default', session: 's/1', identity: 'x' },
        cfg,
      ),
    ).toEqual({
      query: { text: 'hi' },
      session: 's/1',
      actionSpec: { actionDisabled: true },
    });
  });
  it('sessionless turns omit the session (isSessionLess left the schema)', () => {
    const body = buildStreamAssistRequest(
      { text: 'hi', route: 'default', sessionless: true, identity: 'x' },
      cfg,
    );
    expect(body).not.toHaveProperty('isSessionLess');
    expect(body).not.toHaveProperty('session');
  });
  it('can route skills by mention only', () => {
    const body = buildStreamAssistRequest(
      { text: 'do it', route: 'command', identity: 'x' },
      { ...cfg, skillAgentsSpec: false, engineActions: true },
    );
    expect(body).toEqual({
      query: { text: '[slack-surface-commander](mention://?uri=123) do it' },
    });
  });
  it('addresses one agent by its terminal id and refuses agent + skills', () => {
    const body = buildStreamAssistRequest(
      {
        text: 'plan',
        route: 'default',
        identity: 'x',
        agent: { kind: 'deep-research', agentId: 'deep_research' },
      },
      cfg,
    );
    expect(body.agentsSpec).toEqual({ agentSpecs: [{ agentId: 'deep_research' }] });
    expect(body.query).toEqual({ text: 'plan' });
    expect(() =>
      buildStreamAssistRequest(
        { text: 'x', route: 'command', identity: 'x', agent: { kind: 'assistant', agentId: '9' } },
        cfg,
      ),
    ).toThrow(/combined/);
    expect(() =>
      buildStreamAssistRequest(
        { text: 'x', route: 'default', identity: 'x', agent: { kind: 'a2a', agentId: '9' } },
        cfg,
      ),
    ).toThrow(/A2A proxy/);
  });
});

describe('agents and connectors on streamAssist', () => {
  it('reports unauthorized connectors and pauses on a Deep Research plan', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamBody([
            {
              answer: {
                connectorDisplayNames: {
                  'projects/1/locations/eu/collections/jira-fed_1/dataConnector': 'Jira',
                },
                replies: [
                  {
                    groundedContent: {
                      content: { text: '1. Survey vendors' },
                      contentMetadata: { contentKind: 'RESEARCH_PLAN' },
                    },
                  },
                ],
              },
              connectorAuthErrors: [
                { dataConnector: 'projects/1/locations/eu/collections/jira-fed_1/dataConnector' },
                { dataConnector: 'projects/1/locations/eu/collections/sfdc-fed_2/dataConnector' },
              ],
            },
            { sessionInfo: { session: 'projects/1/sessions/77' } },
          ]),
        ),
    );
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(
      client.stream(tokens(), {
        text: 'research',
        route: 'default',
        identity: 'user:a',
        agent: { kind: 'deep-research', agentId: 'deep_research' },
      }),
    );
    expect(events).toContainEqual({ type: 'connector-auth', connectors: ['Jira', 'sfdc-fed_2'] });
    expect(events).toContainEqual({
      type: 'awaiting',
      reason: 'research-plan',
      handle: { session: 'projects/1/sessions/77' },
    });
    const prov = events.find((e) => e.type === 'provenance');
    expect(prov && prov.type === 'provenance' && prov.payload.agentId).toBe(
      'gemini-enterprise:eng/agent:deep_research',
    );
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
  it('shows research questions as activity and points at generated files', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamBody([
            {
              answer: {
                state: 'IN_PROGRESS',
                replies: [
                  {
                    groundedContent: {
                      content: { text: 'What do buyers pay?' },
                      contentMetadata: { contentKind: 'RESEARCH_QUESTION' },
                    },
                  },
                ],
              },
            },
            {
              answer: {
                replies: [
                  { groundedContent: { content: { text: 'Report.' } } },
                  {
                    groundedContent: {
                      content: { file: { mimeType: 'audio/wav', fileId: 'f1' } },
                    },
                  },
                ],
              },
            },
          ]),
        ),
    );
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(
      client.stream(tokens(), {
        text: 'Start Research',
        route: 'default',
        identity: 'user:a',
        session: 'projects/1/sessions/77',
        agent: { kind: 'deep-research', agentId: 'deep_research' },
      }),
    );
    expect(events).toContainEqual({ type: 'activity', text: 'What do buyers pay?' });
    expect(events.filter((e) => e.type === 'token')).toEqual([{ type: 'token', text: 'Report.' }]);
    expect(events).toContainEqual({ type: 'file', mimeType: 'audio/wav', fileId: 'f1' });
    expect(events.some((e) => e.type === 'awaiting')).toBe(false);
  });
});

describe('A2aClient', () => {
  const a2aTurn = (over: Partial<AssistTurn['agent']> = {}): AssistTurn => ({
    text: 'triage INC-1',
    route: 'default',
    identity: 'user:a',
    agent: { kind: 'a2a', agentId: '4242', ...over },
  });
  it('posts A2A v1 JSON to the regional proxy and streams artifacts once', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          streamBody([
            {
              task: {
                id: 't1',
                contextId: 'projects/1/sessions/9',
                status: { state: 'TASK_STATE_WORKING' },
              },
            },
            {
              statusUpdate: {
                taskId: 't1',
                status: {
                  state: 'TASK_STATE_WORKING',
                  message: { content: [{ text: 'Checking logs' }] },
                },
              },
            },
            {
              artifactUpdate: {
                taskId: 't1',
                artifact: { artifactId: 'a', parts: [{ text: 'Root ' }] },
              },
            },
            {
              artifactUpdate: {
                taskId: 't1',
                append: true,
                artifact: { artifactId: 'a', parts: [{ text: 'cause: DNS' }] },
              },
            },
            {
              task: {
                id: 't1',
                status: { state: 'TASK_STATE_COMPLETED' },
                artifacts: [{ artifactId: 'a', parts: [{ text: 'Root cause: DNS' }] }],
              },
            },
          ]),
        ),
    );
    const client = new A2aClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(client.stream(tokens(), a2aTurn()));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      'https://discoveryengine.eu.rep.googleapis.com/v1/projects/p1/locations/eu/collections/default_collection/engines/eng/assistants/default_assistant/agents/4242/a2a/v1/message:stream',
    );
    const body = JSON.parse(String(init.body));
    expect(body.message.role).toBe('ROLE_USER');
    expect(body.message.content).toEqual([{ text: 'triage INC-1' }]);
    expect(body.message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Root cause: DNS');
    expect(events).toContainEqual({ type: 'activity', text: 'Checking logs' });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.some((e) => e.type === 'awaiting')).toBe(false);
  });
  it('pauses for input with the context and task to continue', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamBody([
            {
              statusUpdate: {
                contextId: 'projects/1/sessions/9',
                taskId: 't1',
                status: {
                  state: 'TASK_STATE_INPUT_REQUIRED',
                  message: { role: 'ROLE_AGENT', content: [{ text: 'Which environment?' }] },
                },
              },
            },
          ]),
        ),
    );
    const client = new A2aClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(client.stream(tokens(), a2aTurn()));
    expect(events).toContainEqual({ type: 'token', text: 'Which environment?' });
    expect(events).toContainEqual({
      type: 'awaiting',
      reason: 'input-required',
      handle: { contextId: 'projects/1/sessions/9', taskId: 't1' },
    });
  });
  it('continues a task, never retries a 5xx, and reports failed tasks', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }));
    const client = new A2aClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(
      client.stream(tokens(), a2aTurn({ contextId: 'projects/1/sessions/9', taskId: 't1' })),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'http_503' });
    const sent = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(sent.message).toMatchObject({ contextId: 'projects/1/sessions/9', taskId: 't1' });

    const failing = new A2aClient(
      cfg,
      (async () =>
        new Response(
          streamBody([{ task: { id: 't', status: { state: 'TASK_STATE_FAILED' } } }]),
        )) as unknown as typeof fetch,
    );
    const failed = await all(failing.stream(tokens(), a2aTurn()));
    expect(failed.at(-1)).toMatchObject({ type: 'error', code: 'agent_failed' });
  });
  it('re-sends once on 401 with a fresh token, and the router picks the transport', async () => {
    const t = tokens();
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      ++n === 1
        ? new Response(null, { status: 401 })
        : new Response(
            streamBody([{ message: { role: 'ROLE_AGENT', content: [{ text: 'ok' }] } }]),
          ),
    );
    const router = new GeminiEnterpriseClient(
      new StreamAssistClient(cfg, vi.fn() as unknown as typeof fetch),
      new A2aClient(cfg, fetchImpl as unknown as typeof fetch),
    );
    const events = await all(router.stream(t, a2aTurn()));
    expect(t.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: 'token', text: 'ok' });
    expect(() => a2aStreamUrl(cfg, '../x')).toThrow(/Invalid agent id/);
  });
});

describe('StreamAssistClient', () => {
  it('maps tokens, citations, provenance and done', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamBody([
            {
              sessionInfo: { session: 'sess/1' },
              answer: {
                replies: [{ groundedContent: { content: { text: 'thinking', thought: true } } }],
              },
            },
            {
              answer: {
                replies: [
                  {
                    groundedContent: {
                      content: { text: 'Hello ' },
                      textGroundingMetadata: {
                        references: [
                          {
                            content: 'a‮b  c',
                            documentMetadata: { title: 'Runbook', uri: 'https://r' },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
            {
              answer: {
                replies: [{ groundedContent: { content: { text: 'world' } } }],
                relatedQuestions: ['Why?'],
              },
            },
          ]),
          { status: 200 },
        ),
    );
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const events = await all(
      client.stream(tokens(), { text: 'q', route: 'default', identity: 'user:a@b.com' }),
    );
    expect(events.map((e) => e.type)).toEqual([
      'activity',
      'token',
      'citation',
      'token',
      'related-questions',
      'provenance',
      'done',
    ]);
    const cit = events.find((e) => e.type === 'citation');
    expect(cit).toMatchObject({ source: { title: 'Runbook', uri: 'https://r', excerpt: 'ab c' } });
    const prov = events.find((e) => e.type === 'provenance');
    expect(prov && prov.type === 'provenance' && prov.payload).toMatchObject({
      identity: 'user:a@b.com',
      sessionId: 'sess/1',
      sources: [{ title: 'Runbook', uri: 'https://r' }],
    });
    expect(JSON.stringify(prov)).not.toContain('excerpt');
  });

  it('suppresses all output after a Model Armor block', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamBody([
            {
              answer: {
                customerPolicyEnforcementResult: { verdict: 'BLOCK' },
                replies: [{ groundedContent: { content: { text: 'secret' } } }],
              },
            },
            { answer: { replies: [{ groundedContent: { content: { text: 'more' } } }] } },
          ]),
        ),
    );
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const r = await collectStream(
      client.stream(tokens(), { text: 'q', route: 'default', identity: 'x' }),
    );
    expect(r.blocked).toBe(true);
    expect(r.text).toBe('');
    expect(r.provenance).toBeUndefined();
  });

  it('invalidates the token once on 401', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0 ? new Response(null, { status: 401 }) : new Response(streamBody([])),
    );
    const t = tokens();
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const r = await collectStream(client.stream(t, { text: 'q', route: 'default', identity: 'x' }));
    expect(t.invalidate).toHaveBeenCalledTimes(1);
    expect(r.complete).toBe(true);
  });

  it('reports http errors without provenance', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }));
    const client = new StreamAssistClient(cfg, fetchImpl as unknown as typeof fetch);
    const r = await collectStream(
      client.stream(tokens(), { text: 'q', route: 'default', identity: 'x' }),
    );
    expect(r.error).toEqual({ code: 'http_403', message: 'denied' });
    expect(r.complete).toBe(false);
  });
});

describe('token sources', () => {
  it('WIF exchanges the id_token at STS with the workforce audience and caches', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        audience: '//iam.googleapis.com/locations/global/workforcePools/pool/providers/okta',
        subjectToken: 'idt',
        subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
      });
      return Response.json({ access_token: 'g1', token_type: 'Bearer', expires_in: 3600 });
    });
    const wif = new WifTokenClient(
      { getIdToken: async () => 'idt' },
      { poolId: 'pool', providerId: 'okta' },
      fetchImpl as unknown as typeof fetch,
    );
    const [a, b] = await Promise.all([wif.getAccessToken(), wif.getAccessToken()]);
    expect(a).toBe('g1');
    expect(b).toBe('g1');
    await wif.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    wif.invalidate();
    await wif.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('metadata server and impersonation mint keyless service tokens', async () => {
    const now = Date.parse('2026-10-05T10:00:00Z');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://metadata.google.internal')) {
        expect((init?.headers as Record<string, string>)['Metadata-Flavor']).toBe('Google');
        return Response.json({ access_token: 'runtime', expires_in: 3000 });
      }
      expect(url).toContain(
        'serviceAccounts/ge-bot%40p1.iam.gserviceaccount.com:generateAccessToken',
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer runtime');
      return Response.json({ accessToken: 'licensed', expireTime: '2026-10-05T11:00:00Z' });
    });
    const base = new MetadataServerTokenSource(
      fetchImpl as unknown as typeof fetch,
      undefined,
      () => now,
    );
    const sa = new ImpersonatedTokenSource(
      base,
      { targetServiceAccount: 'ge-bot@p1.iam.gserviceaccount.com' },
      fetchImpl as unknown as typeof fetch,
      () => now,
    );
    expect(await sa.getAccessToken()).toBe('licensed');
    expect(
      () => new ImpersonatedTokenSource(base, { targetServiceAccount: 'alice@acme.com' }),
    ).toThrow();
  });
});
