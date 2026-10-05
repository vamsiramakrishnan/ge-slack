import { describe, expect, it } from 'vitest';
import { fromSlackMetadata, type ActuationRequest } from '@ge-slack/contracts';
import { SlackSurface } from './surface.js';
import { SlackTurnSink, defaultResponsePoster } from './sink.js';
import { answerBlocks, markdownBlocks, planBlocks, citationElements } from './blocks.js';
import type { SlackApi, SlackApiResponse } from './slack-api.js';

type Handler = (args: Record<string, unknown>) => SlackApiResponse | Promise<SlackApiResponse>;

/** Recording fake of the Slack Web API (not Slack evidence). */
class FakeSlack implements SlackApi {
  calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  constructor(private readonly handlers: Record<string, Handler> = {}) {}
  async call(method: string, args: Record<string, unknown>): Promise<SlackApiResponse> {
    this.calls.push({ method, args });
    const h = this.handlers[method];
    if (!h) return { ok: true };
    return h(args);
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}

const prov = {
  changeId: 'chg_abcdef123456',
  agentId: 'gemini-enterprise:eng',
  principal: 'user:alex@acme.com',
  invoker: 'U0ALEX',
  approvedBy: 'U0ALEX',
  approval: 'human' as const,
  edited: false,
  timestamp: '2026-10-05T10:00:00Z',
  contentHash: 'sha256:x',
  sources: [{ title: 'Runbook', uri: 'https://docs.acme.com/r' }],
};

describe('SlackSurface reads', () => {
  it('membership pages through members and fails closed on errors', async () => {
    const api = new FakeSlack({
      'conversations.members': (a) =>
        a.cursor
          ? { ok: true, members: ['U2'] }
          : { ok: true, members: ['U1'], response_metadata: { next_cursor: 'c1' } },
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme' });
    expect(await s.isMember('C1', 'U2')).toBe(true);
    expect(await s.isMember('C1', 'U9')).toBe(false);
    const denied = new SlackSurface(
      new FakeSlack({ 'conversations.members': () => ({ ok: false, error: 'not_in_channel' }) }),
      { teamId: 'T1' },
    );
    expect(await denied.isMember('C1', 'U1')).toBe(false);
  });

  it('treats any shared channel as externally shared', async () => {
    const api = new FakeSlack({
      'conversations.info': () => ({ ok: true, channel: { name: 'vendor', is_ext_shared: true } }),
    });
    expect((await new SlackSurface(api, { teamId: 'T1' }).conversationInfo('C1')).isExtShared).toBe(
      true,
    );
  });

  it('captures a thread with permalinks, author names, app marking and from: filter', async () => {
    const api = new FakeSlack({
      'conversations.replies': () => ({
        ok: true,
        messages: [
          { ts: '1700000000.000100', user: 'U1', text: 'parent', thread_ts: '1700000000.000100' },
          {
            ts: '1700000000.000200',
            user: 'U2',
            text: 'reply',
            thread_ts: '1700000000.000100',
            files: [{ title: 'log.txt' }],
          },
          {
            ts: '1700000000.000300',
            bot_id: 'B1',
            app_id: 'A0GE',
            subtype: 'bot_message',
            text: 'from us',
          },
          { ts: '1700000000.000400', subtype: 'channel_join', user: 'U3', text: 'joined' },
        ],
      }),
      'conversations.info': () => ({ ok: true, channel: { name: 'eng' } }),
      'users.info': (a) => ({ ok: true, user: { real_name: a.user === 'U1' ? 'Maya' : 'Li' } }),
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme', appId: 'A0GE' });
    const ctx = await s.capture(
      { kind: 'thread', channel: 'C1', ts: '1700000000.000100' },
      { from: [], maxMessages: 50 },
    );
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({
      author: 'Maya',
      permalink: 'https://acme.slack.com/archives/C1/p1700000000000100',
    });
    expect(ctx.messages[1]!.text).toContain('[file: log.txt]');
    expect(ctx.messages[1]!.permalink).toContain('?thread_ts=1700000000.000100&cid=C1');
    expect(ctx.messages[2]!.fromApp).toBe(true);
    const filtered = await s.capture(
      { kind: 'thread', channel: 'C1', ts: '1700000000.000100' },
      { from: ['U2'], maxMessages: 50 },
    );
    expect(filtered.messages.map((m) => m.user)).toEqual(['U2']);
  });

  it('bounds channel history by window and budget', async () => {
    const api = new FakeSlack({
      'conversations.history': (a) => ({
        ok: true,
        messages: Array.from({ length: Number(a.limit) }, (_, i) => ({
          ts: `17000000${String(i).padStart(2, '0')}.000100`,
          user: 'U1',
          text: `m${i}`,
        })),
        response_metadata: { next_cursor: 'more' },
      }),
      'conversations.info': () => ({ ok: true, channel: { name: 'eng' } }),
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme', now: () => 1_800_000_000_000 });
    const ctx = await s.capture(
      { kind: 'channel', channel: 'C1', sinceMs: 86_400_000 },
      { from: [], maxMessages: 30 },
    );
    expect(ctx.messages).toHaveLength(30);
    expect(ctx.truncated).toBe(true);
    expect(api.calls.find((c) => c.method === 'conversations.history')!.args.oldest).toBe(
      String(1_800_000_000 - 86_400),
    );
    expect(ctx.label).toBe('#eng · last 1d');
  });
});

describe('SlackSurface access + write client', () => {
  it('identifies canvases and the conversations they are shared in', async () => {
    const api = new FakeSlack({
      'files.info': () => ({
        ok: true,
        file: { filetype: 'quip', channels: ['C1'], groups: ['G2'] },
      }),
    });
    expect(await new SlackSurface(api, { teamId: 'T1' }).canvasAccess('F1')).toEqual({
      isCanvas: true,
      channels: ['C1', 'G2'],
    });
    const pdf = new FakeSlack({
      'files.info': () => ({ ok: true, file: { filetype: 'pdf', channels: ['C1'] } }),
    });
    expect((await new SlackSurface(pdf, { teamId: 'T1' }).canvasAccess('F2')).isCanvas).toBe(false);
  });
  it('sends writes through the non-retrying write client', async () => {
    const reads = new FakeSlack();
    const writes = new FakeSlack({
      'chat.postMessage': () => ({ ok: true, ts: '1.1', channel: 'C1' }),
    });
    const s = new SlackSurface(reads, { teamId: 'T1', domain: 'acme', writeApi: writes });
    await s.actuate({
      changeId: 'chg_12345678',
      params: { kind: 'post', channel: 'C1A', text: 'x' },
    });
    expect(writes.methods()).toEqual(['chat.postMessage']);
    expect(reads.methods()).toEqual([]);
  });
});

describe('SlackSurface writes', () => {
  const reply: ActuationRequest = {
    changeId: 'chg_abcdef123456',
    params: { kind: 'reply', channel: 'C1', threadTs: '1700000000.000100', text: 'Owners: Maya' },
    provenance: prov,
  };

  it('posts with provenance metadata + footer and returns a delete inverse', async () => {
    const api = new FakeSlack({
      'chat.postMessage': () => ({ ok: true, ts: '1800000000.000001', channel: 'C1' }),
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme' });
    const r = await s.actuate(reply);
    expect(r).toMatchObject({
      outcome: 'applied',
      provenancePersisted: true,
      inverse: { op: 'delete-message', channel: 'C1', ts: '1800000000.000001' },
    });
    const args = api.calls[0]!.args;
    expect(args.thread_ts).toBe('1700000000.000100');
    expect(fromSlackMetadata(args.metadata)).toMatchObject({
      changeId: 'chg_abcdef123456',
      principal: 'user:alex@acme.com',
    });
    expect(JSON.stringify(args.blocks)).toContain('Drafted by Gemini for <@U0ALEX>');
  });

  it('maps Slack errors to failed and transport errors to a throw (uncertain upstream)', async () => {
    const failing = new SlackSurface(
      new FakeSlack({ 'chat.postMessage': () => ({ ok: false, error: 'not_in_channel' }) }),
      { teamId: 'T1' },
    );
    expect(await failing.actuate(reply)).toMatchObject({
      outcome: 'failed',
      error: { code: 'not_in_channel' },
    });
    const broken = new SlackSurface(
      new FakeSlack({ 'chat.postMessage': () => Promise.reject(new Error('ECONNRESET')) }),
      { teamId: 'T1' },
    );
    await expect(broken.actuate(reply)).rejects.toThrow('ECONNRESET');
  });

  it('schedules reminders into the person’s DM with a cancellable inverse', async () => {
    const api = new FakeSlack({
      'conversations.open': () => ({ ok: true, channel: { id: 'D0MAYA' } }),
      'chat.scheduleMessage': () => ({ ok: true, scheduled_message_id: 'Q1' }),
    });
    const s = new SlackSurface(api, { teamId: 'T1' });
    const r = await s.actuate({
      changeId: 'chg_remind0001',
      params: { kind: 'remind', user: 'U0MAYA', postAt: 1_900_000_000, text: 'TTL' },
      provenance: prov,
    });
    expect(r.inverse).toEqual({
      op: 'delete-scheduled',
      channel: 'D0MAYA',
      scheduledMessageId: 'Q1',
      postAt: 1_900_000_000,
    });
    expect(String(api.calls[1]!.args.text)).toContain('requested by <@U0ALEX>');
  });

  it('canvas edits are honestly not reversible', async () => {
    const s = new SlackSurface(new FakeSlack(), { teamId: 'T1' });
    const r = await s.actuate({
      changeId: 'chg_canvasedit1',
      params: { kind: 'canvas-edit', canvasId: 'F1', markdown: '# x' },
    });
    expect(r.inverse?.op).toBe('not-reversible');
  });

  it('undo runs the matching inverse call', async () => {
    const api = new FakeSlack();
    const s = new SlackSurface(api, { teamId: 'T1' });
    expect(
      (await s.undo({ op: 'delete-scheduled', channel: 'C1', scheduledMessageId: 'Q1', postAt: 1 }))
        .ok,
    ).toBe(true);
    expect(api.calls[0]).toMatchObject({
      method: 'chat.deleteScheduledMessage',
      args: { scheduled_message_id: 'Q1' },
    });
  });
});

describe('SlackTurnSink', () => {
  const answer = {
    turnId: 't1',
    text: 'Hello',
    sources: [{ title: 'Runbook', uri: 'https://docs.acme.com/r' }],
    identity: { kind: 'user' as const, label: 'alex@acme.com' },
    grounded: true,
    related: [],
    warnings: [],
    shareable: false,
    followUps: true,
  };

  it('streams plan tasks + markdown and attaches blocks at stop', async () => {
    const api = new FakeSlack({
      'chat.startStream': () => ({ ok: true, ts: '1.1', channel: 'C1' }),
    });
    let t = 0;
    const sink = new SlackTurnSink(
      api,
      { mode: 'stream', channel: 'C1', threadTs: '1700000000.000100', userId: 'U1', teamId: 'T1' },
      undefined,
      () => (t += 1000),
    );
    await sink.begin('Summarize this thread');
    await sink.task({ id: 'capture', title: 'Read 2 messages', status: 'complete' });
    await sink.token('Hel');
    await sink.token('lo');
    await sink.answer(answer);
    expect(api.methods()).toEqual([
      'chat.startStream',
      'chat.appendStream',
      'chat.appendStream',
      'chat.appendStream',
      'chat.stopStream',
    ]);
    expect(api.calls[0]!.args).toMatchObject({
      task_display_mode: 'plan',
      recipient_user_id: 'U1',
      chunks: [{ type: 'plan_update', title: 'Summarize this thread' }],
    });
    expect(api.calls[1]!.args.chunks).toEqual([
      { type: 'task_update', id: 'capture', title: 'Read 2 messages', status: 'complete' },
    ]);
    expect(JSON.stringify(api.calls.at(-1)!.args.blocks)).toContain('feedback_buttons');
  });

  it('falls back to postMessage/update when streaming is unavailable', async () => {
    const api = new FakeSlack({
      'chat.startStream': () => ({ ok: false, error: 'unknown_method' }),
      'chat.postMessage': () => ({ ok: true, ts: '2.2', channel: 'C1' }),
    });
    const sink = new SlackTurnSink(api, {
      mode: 'stream',
      channel: 'C1',
      userId: 'U1',
      teamId: 'T1',
    });
    await sink.begin('x');
    await sink.task({ id: 'a', title: 'step', status: 'in_progress' });
    await sink.token('Hello');
    await sink.answer(answer);
    // No thread yet: a visible anchor is posted first, then streaming is attempted in its thread.
    expect(api.methods().slice(0, 2)).toEqual(['chat.postMessage', 'chat.startStream']);
    expect(api.calls[1]!.args.thread_ts).toBe('2.2');
    expect(api.methods()).toContain('chat.postMessage');
    expect(api.methods().at(-1)).toBe('chat.update');
  });

  it('attaches ge_provenance metadata and closes the agent session at stop', async () => {
    const api = new FakeSlack({
      'chat.startStream': () => ({ ok: true, ts: '1.1', channel: 'D1' }),
    });
    const sink = new SlackTurnSink(api, {
      mode: 'stream',
      channel: 'D1',
      threadTs: '1700000000.000100',
      userId: 'U1',
      teamId: 'T1',
      agentSession: true,
    });
    await sink.begin('x');
    await sink.token('Hi');
    await sink.answer({ ...answer, provenance: { ...prov, changeId: 'ans_t1' } });
    const stop = api.calls.find((c) => c.method === 'chat.stopStream')!;
    expect(stop.args.session_status).toBe('active');
    expect(fromSlackMetadata(stop.args.metadata)).toMatchObject({ changeId: 'ans_t1' });
  });

  it('ephemeral mode uses response_url once for progress and once for the answer', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const sink = new SlackTurnSink(
      new FakeSlack(),
      { mode: 'ephemeral', channel: 'C1', userId: 'U1', responseUrl: 'https://hooks.slack.com/x' },
      async (_u, b) => {
        posts.push(b);
      },
    );
    await sink.begin('x');
    await sink.task({ id: 'a', title: 'one', status: 'in_progress' });
    await sink.task({ id: 'b', title: 'two', status: 'in_progress' });
    await sink.answer({ ...answer, shareable: true });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ response_type: 'ephemeral', replace_original: true });
    expect(JSON.stringify(posts[1])).toContain('Share to channel');
  });

  it('connect prompts are always private, even from a public mention', async () => {
    const api = new FakeSlack();
    const sink = new SlackTurnSink(api, {
      mode: 'stream',
      channel: 'C1',
      userId: 'U1',
      teamId: 'T1',
    });
    await sink.connect({
      message: 'Connect',
      connectUrl: 'https://idp/x',
      providerName: 'Acme SSO',
      offerService: false,
      serviceSources: [],
    });
    expect(api.methods()).toEqual(['chat.postEphemeral']);
  });

  it('refuses non-Slack response URLs', async () => {
    await expect(defaultResponsePoster('https://evil.example.com/hook', {})).rejects.toThrow(
      /non-Slack/,
    );
  });
});

describe('blocks', () => {
  it('splits long markdown and bounds block counts', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(400)}`).join(
      '\n\n',
    );
    const blocks = markdownBlocks(long);
    expect(blocks.length).toBeGreaterThan(4);
    expect(blocks.every((b) => String(b.text).length <= 2900)).toBe(true);
    expect(
      answerBlocks(
        {
          ...{
            turnId: 't',
            sources: [],
            identity: { kind: 'service', label: 'x' },
            grounded: false,
            related: [],
            warnings: [],
            shareable: false,
            followUps: false,
          },
          text: long,
        },
        { includeText: true },
      ).length,
    ).toBeLessThanOrEqual(50);
  });

  it('marks ungrounded answers and escapes untrusted source titles/links', () => {
    const b = answerBlocks(
      {
        turnId: 't',
        text: 'x',
        sources: [],
        identity: { kind: 'service', label: 'sa' },
        grounded: false,
        related: [],
        warnings: [],
        shareable: false,
        followUps: false,
      },
      { includeText: false },
    );
    expect(JSON.stringify(b)).toContain('ungrounded');
    expect(JSON.stringify(b)).toContain('as Gemini service');
    const c = citationElements([
      { title: '<!channel> & co', uri: 'javascript:alert(1)' },
      { title: 'ok', uri: 'https://a|b' },
    ]);
    expect(JSON.stringify(c)).not.toContain('<!channel>');
    expect(JSON.stringify(c)).not.toContain('javascript:');
    expect(JSON.stringify(c)).not.toContain('https://a|b');
  });

  it('plan cards name the approver and offer approve/edit/cancel', () => {
    const b = planBlocks({
      planId: 'p1',
      title: 'Gemini wants to make 1 change',
      grammar: 'draft "x"',
      effects: [
        {
          index: 1,
          kind: 'reply',
          label: 'Reply in thread',
          preview: 'hi',
          approvalClass: 'in-conversation',
          reversible: true,
          line: 'reply "hi"',
        },
      ],
      identity: { kind: 'user', label: 'alex@acme.com' },
      invokerId: 'U0ALEX',
      steps: [],
      dryRun: false,
      expiresAt: '2026-10-05T10:30:00Z',
      sources: [],
    });
    const s = JSON.stringify(b);
    expect(s).toContain('only <@U0ALEX> can approve');
    expect(s).toContain('ge_approve');
    expect(s).toContain('ge_edit');
  });
});
