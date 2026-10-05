import { describe, expect, it, vi } from 'vitest';
import type { AssistEvent } from '@ge-slack/contracts';
import { StreamAssistClient, buildStreamAssistRequest, collectStream } from './stream-assist.js';
import { discoveryEngineHost, streamAssistUrl, type GeminiClientConfig } from './config.js';
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
      isSessionLess: true,
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
    });
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
