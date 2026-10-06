import { describe, expect, it } from 'vitest';
import { fromSlackMetadata, type ActuationRequest } from '@ge-slack/contracts';
import { SlackSurface } from './surface.js';
import { SlackTurnSink, defaultResponsePoster } from './sink.js';
import {
  agentReplyModal,
  memoryBlocks,
  answerBlocks,
  awaitingBlocks,
  markdownBlocks,
  planBlocks,
  citationElements,
} from './blocks.js';
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
      verb: 'draft',
      effects: [
        {
          index: 1,
          changeId: 'chg_x1234567',
          skipped: false,
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

describe('next stage: rich cards, Lists, canvas sections, search', () => {
  const view = (verb: 'review' | 'draft', n = 2) => ({
    planId: 'p1',
    verb,
    title: 't',
    grammar: 'review',
    effects: Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      changeId: `chg_${i}aaaaaaaa`,
      skipped: i === 1,
      kind: 'reply' as const,
      label: 'Reply in thread',
      preview: `🔎 *Finding · ${i ? 'low' : 'high'}* issue ${i}`,
      approvalClass: 'in-conversation' as const,
      reversible: true,
      line: `finding <x> "issue ${i}"`,
    })),
    identity: { kind: 'user' as const, label: 'alex@acme.com' },
    invokerId: 'U0ALEX',
    steps: [],
    dryRun: false,
    expiresAt: '2026-10-05T10:30:00Z',
    sources: [],
  });

  it('renders review findings as a data_table with per-row toggles, and a classic fallback', async () => {
    const { planBlocks } = await import('./blocks.js');
    const rich = planBlocks(view('review'), { rich: true });
    const table = rich.find((b) => b.type === 'data_table') as {
      rows: Array<Array<Record<string, unknown>>>;
    };
    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]![1]).toEqual({ type: 'raw_text', text: 'high' });
    expect(table.rows[2]![3]).toMatchObject({
      type: 'action_cell',
      element: { action_id: 'ge_finding_toggle_2', value: 'p1:chg_1aaaaaaaa' },
    });
    expect(JSON.stringify(rich)).toContain('Post 1 finding');
    const classic = planBlocks(view('review'), { rich: false });
    expect(JSON.stringify(classic)).not.toContain('data_table');
    expect(JSON.stringify(classic)).toContain('ge_finding_toggle_1');
  });

  it('retries with classic blocks when Slack rejects rich ones', async () => {
    const { withRichFallback } = await import('./sink.js');
    const sent: boolean[] = [];
    await withRichFallback(
      (o) => [{ rich: o.rich }],
      async (blocks) => {
        sent.push(Boolean((blocks[0] as { rich: boolean }).rich));
        if (sent.length === 1) throw new Error('response_url failed (400): invalid_blocks');
      },
    );
    expect(sent).toEqual([true, false]);
    await expect(
      withRichFallback(
        () => [],
        async () => Promise.reject(new Error('channel_not_found')),
      ),
    ).rejects.toThrow();
  });

  it('clicked cards become a live plan-block receipt without changing visibility', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const sink = new SlackTurnSink(
      new FakeSlack(),
      {
        mode: 'ephemeral',
        channel: 'C1',
        userId: 'U0ALEX',
        responseUrl: 'https://hooks.slack.com/x',
        card: true,
      },
      async (_u, b) => {
        posts.push(b);
      },
    );
    await sink.executing(view('draft', 1));
    await sink.landed({
      planId: 'p1',
      title: 'draft "x"',
      results: [
        {
          changeId: 'chg_0aaaaaaaa',
          kind: 'reply',
          label: 'Reply in thread',
          outcome: 'applied',
          permalink: 'https://acme.slack.com/archives/C1/p1',
          undoable: true,
        },
      ],
      identity: { kind: 'user', label: 'alex@acme.com' },
      skipped: 0,
    });
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.response_type).toBeUndefined();
      expect(p.replace_original).toBe(true);
    }
    const plan = (posts[1]!.blocks as Array<Record<string, unknown>>).find(
      (b) => b.type === 'plan',
    ) as { tasks: Array<Record<string, unknown>> };
    expect(plan.tasks[0]).toMatchObject({ status: 'complete', output: { type: 'rich_text' } });
    expect(JSON.stringify(posts[1])).toContain('ge_undo');
  });

  const items = {
    changeId: 'chg_list00001',
    params: {
      kind: 'action-items' as const,
      title: 'Action items — thread',
      items: [{ text: 'Raise TTL', owner: 'U0MAYA', due: '2026-10-09' }, { text: 'Postmortem' }],
      channel: 'C1A',
      threadTs: '1700000000.000100',
    },
    provenance: prov,
  };

  it('creates a Slack List with typed fields, shares and announces it, with an undo inverse', async () => {
    let n = 0;
    const api = new FakeSlack({
      'slackLists.create': () => ({
        ok: true,
        list_id: 'F0LIST',
        list_metadata: {
          schema: [
            { key: 'task', id: 'Col1' },
            { key: 'owner', id: 'Col2' },
            { key: 'due', id: 'Col3' },
            { key: 'done', id: 'Col4' },
          ],
        },
      }),
      'slackLists.items.create': () => ({ ok: true, item: { id: `Rec${++n}` } }),
      'files.info': () => ({
        ok: true,
        file: { permalink: 'https://acme.slack.com/lists/T1/F0LIST' },
      }),
      'chat.postMessage': () => ({ ok: true, ts: '1800000000.000001' }),
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme' });
    const r = await s.actuate(items);
    expect(r).toMatchObject({
      outcome: 'applied',
      location: { listId: 'F0LIST', permalink: 'https://acme.slack.com/lists/T1/F0LIST' },
      inverse: {
        op: 'delete-list-items',
        listId: 'F0LIST',
        itemIds: ['Rec1', 'Rec2'],
        announcement: { channel: 'C1A', ts: '1800000000.000001' },
      },
    });
    const first = api.calls.find((c) => c.method === 'slackLists.items.create')!.args
      .initial_fields as Array<Record<string, unknown>>;
    expect(first).toEqual([
      {
        column_id: 'Col1',
        rich_text: [
          {
            type: 'rich_text',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'Raise TTL' }] },
            ],
          },
        ],
      },
      { column_id: 'Col2', user: ['U0MAYA'] },
      { column_id: 'Col3', date: ['2026-10-09'] },
    ]);
    expect(api.methods()).toContain('slackLists.access.set');
    const undo = await s.undo(r.inverse!);
    expect(undo.ok).toBe(true);
    expect(api.methods().slice(-2)).toEqual(['slackLists.items.deleteMultiple', 'chat.delete']);
  });

  it('falls back to a checklist (and says so) when Lists is unavailable', async () => {
    const api = new FakeSlack({
      'slackLists.create': () => ({ ok: false, error: 'lists_disabled_user_team' }),
      'chat.postMessage': () => ({ ok: true, ts: '1800000000.000002' }),
    });
    const r = await new SlackSurface(api, { teamId: 'T1', domain: 'acme' }).actuate(items);
    expect(r).toMatchObject({ outcome: 'applied', inverse: { op: 'delete-message' } });
    expect(r.note).toContain('checklist');
    expect(String(api.calls.at(-1)!.args.text)).toContain('☐ <@U0MAYA> Raise TTL — due 2026-10-09');
  });

  it('canvas edits by heading resolve exactly one section or change nothing', async () => {
    const req = (heading: string) => ({
      changeId: 'chg_canvas001',
      params: {
        kind: 'canvas-edit' as const,
        canvasId: 'F1',
        markdown: '## Status\nDone',
        heading,
      },
    });
    const one = new FakeSlack({
      'canvases.sections.lookup': () => ({ ok: true, sections: [{ id: 'temp:C:1' }] }),
    });
    await new SlackSurface(one, { teamId: 'T1' }).actuate(req('Status'));
    expect(one.calls.at(-1)).toMatchObject({
      method: 'canvases.edit',
      args: { changes: [{ operation: 'replace', section_id: 'temp:C:1' }] },
    });
    const two = new FakeSlack({
      'canvases.sections.lookup': () => ({ ok: true, sections: [{ id: 'a' }, { id: 'b' }] }),
    });
    const r2 = await new SlackSurface(two, { teamId: 'T1' }).actuate(req('S'));
    expect(r2).toMatchObject({ outcome: 'failed', error: { code: 'heading_ambiguous' } });
    expect(two.methods()).not.toContain('canvases.edit');
  });

  it('reads full canvas markdown via canvases.getContent', async () => {
    const api = new FakeSlack({
      'canvases.getContent': () => ({ ok: true, content: '# Plan\n- [ ] ship' }),
      'files.info': () => ({ ok: true, file: { title: 'Plan' } }),
    });
    const ctx = await new SlackSurface(api, { teamId: 'T1' }).capture(
      { kind: 'canvas', id: 'F1' },
      { from: [], maxMessages: 10 },
    );
    expect(ctx.canvas).toMatchObject({ title: 'Plan', markdown: '# Plan\n- [ ] ship' });
    expect(ctx.truncated).toBe(false);
  });

  it('uses Real-time Search with the action token, else a labelled channel keyword filter', async () => {
    const api = new FakeSlack({
      'assistant.search.context': () => ({
        ok: true,
        results: {
          messages: [
            {
              channel_id: 'C9',
              channel_name: 'eng',
              message_ts: '1700000000.000900',
              content: 'freeze 10-12',
              author_user_id: 'U1',
              author_name: 'Maya',
              permalink: 'https://acme.slack.com/archives/C9/p1700000000000900',
            },
          ],
        },
      }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          { ts: '1700000000.000100', user: 'U1', text: 'the freeze' },
          { ts: '1700000000.000200', user: 'U1', text: 'lunch' },
        ],
      }),
      'conversations.info': () => ({ ok: true, channel: { name: 'general' } }),
    });
    const s = new SlackSurface(api, { teamId: 'T1', domain: 'acme' });
    const scope = { kind: 'search' as const, channel: 'C1', query: 'freeze', sinceMs: 86_400_000 };
    const found = await s.capture(scope, { from: [], maxMessages: 50, actionToken: 'tok' });
    expect(api.calls[0]).toMatchObject({
      method: 'assistant.search.context',
      args: { action_token: 'tok', channel_types: ['public_channel'] },
    });
    expect(found.messages[0]).toMatchObject({
      channel: 'C9',
      ts: '1700000000.000900',
      author: 'Maya in #eng',
    });
    const fallback = await s.capture(scope, { from: [], maxMessages: 50 });
    expect(fallback.messages.map((m) => m.text)).toEqual(['the freeze']);
    expect(fallback.label).toContain('workspace search works from @Gemini');
  });

  it('treats lookup failures as guests (fail closed)', async () => {
    const s = new SlackSurface(
      new FakeSlack({ 'users.info': () => ({ ok: false, error: 'user_not_found' }) }),
      { teamId: 'T1' },
    );
    expect(await s.isGuest('U1')).toBe(true);
  });
});

describe('stage-2 security regressions', () => {
  it('treats Slack Connect strangers and other-team users as guests (M4)', async () => {
    const mk = (user: Record<string, unknown>) =>
      new SlackSurface(new FakeSlack({ 'users.info': () => ({ ok: true, user }) }), {
        teamId: 'T1',
      });
    expect(await mk({ is_stranger: true }).isGuest('U1')).toBe(true);
    expect(await mk({ team_id: 'T9' }).isGuest('U1')).toBe(true);
    expect(await mk({ team_id: 'T1' }).isGuest('U1')).toBe(false);
  });

  it('notices on a clicked card go only to the clicker; cancel retires the card (M5)', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const sink = new SlackTurnSink(
      new FakeSlack(),
      {
        mode: 'ephemeral',
        channel: 'C1',
        userId: 'U9',
        responseUrl: 'https://hooks.slack.com/x',
        card: true,
      },
      async (_u, b) => {
        posts.push(b);
      },
    );
    await sink.notice('denied', 'Only <@U0ALEX> can approve this plan.');
    expect(posts[0]).toMatchObject({ response_type: 'ephemeral', replace_original: false });
    await sink.retire('Cancelled — nothing was changed.');
    expect(posts[1]).toMatchObject({ replace_original: true });
    expect(posts[1]!.response_type).toBeUndefined();
  });

  it('keeps undo when the list exists but the announcement fails (M6)', async () => {
    const api = new FakeSlack({
      'slackLists.create': () => ({
        ok: true,
        list_id: 'F0L',
        list_metadata: { schema: [{ key: 'task', id: 'C1x' }] },
      }),
      'slackLists.items.create': () => ({ ok: true, item: { id: 'Rec1' } }),
      'slackLists.access.set': () => ({ ok: false, error: 'restricted_action' }),
      'chat.postMessage': () => ({ ok: false, error: 'not_in_channel' }),
    });
    const r = await new SlackSurface(api, { teamId: 'T1' }).actuate({
      changeId: 'chg_list00002',
      params: { kind: 'action-items', title: 'AI', items: [{ text: 'x' }], channel: 'C1A' },
      provenance: prov,
    });
    expect(r).toMatchObject({
      outcome: 'applied',
      provenancePersisted: false,
      inverse: { op: 'delete-list-items', itemIds: ['Rec1'] },
    });
    expect(r.inverse).not.toHaveProperty('announcement');
    expect(r.note).toContain('could not be shared');
    expect(r.note).toContain('announcement could not be posted');
  });

  it('drops search hits from private or DM conversations (L2)', async () => {
    const api = new FakeSlack({
      'assistant.search.context': () => ({
        ok: true,
        results: {
          messages: [
            { channel_id: 'C0PUB', message_ts: '1700000000.000001', content: 'public' },
            { channel_id: 'G0PRIV', message_ts: '1700000000.000002', content: 'private' },
          ],
        },
      }),
      'conversations.info': (a) => ({
        ok: true,
        channel: { name: String(a.channel), is_private: a.channel === 'G0PRIV' },
      }),
    });
    const ctx = await new SlackSurface(api, { teamId: 'T1' }).capture(
      { kind: 'search', channel: 'C1', query: 'q', sinceMs: 1 },
      { from: [], maxMessages: 10, actionToken: 't' },
    );
    expect(ctx.messages.map((m) => m.text)).toEqual(['public']);
  });
});

describe('agent blocks (ADR-0002)', () => {
  const base = { continuationId: 'k1', agentTitle: 'Deep <Research>', invokerId: 'U1' };
  it('offers start / change for a research plan and escapes the title', () => {
    const blocks = awaitingBlocks({ ...base, reason: 'research-plan' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('ge_agent_start');
    expect(json).toContain('ge_agent_reply');
    expect(json).toContain('Deep &lt;Research&gt;');
  });
  it('only links https authorize URLs', () => {
    const ok = JSON.stringify(
      awaitingBlocks({ ...base, reason: 'auth-required', authorizeUrl: 'https://ge.example/a' }),
    );
    expect(ok).toContain('"url":"https://ge.example/a"');
    expect(ok).toContain('ge_agent_retry');
    const bad = JSON.stringify(
      awaitingBlocks({ ...base, reason: 'auth-required', authorizeUrl: 'javascript:alert(1)' }),
    );
    expect(bad).not.toContain('javascript');
  });
  it('shows which agent answered and a modal for replies', () => {
    const blocks = answerBlocks(
      {
        turnId: 't',
        text: 'x',
        sources: [],
        identity: { kind: 'user', label: 'alex@acme.com' },
        grounded: false,
        related: [],
        warnings: [],
        shareable: false,
        followUps: false,
        via: 'Triage · A2A',
        authorizeUrl: 'https://ge.example/a',
      },
      { includeText: false },
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('via Triage · A2A');
    expect(json).toContain('Authorize sources');
    const modal = agentReplyModal({
      continuationId: 'k1',
      agentTitle: 'Triage',
      reason: 'input-required',
    });
    expect(modal.private_metadata).toBe('k1');
  });
});

describe('memory blocks (stage 3)', () => {
  it('escapes note text, links only https permalinks, and keys Forget by channel and id', () => {
    const json = JSON.stringify(
      memoryBlocks({
        channel: 'C1',
        notes: [
          {
            n: 1,
            id: 'abc123',
            text: '<!here> & <b>',
            author: 'U1',
            at: '2026-10-06T00:00:00Z',
            permalink: 'javascript:x',
          },
          {
            n: 2,
            id: 'def456',
            text: 'ok',
            author: 'U1',
            at: '2026-10-06T00:00:00Z',
            sourceUser: 'U2',
            permalink: 'https://acme.slack.com/archives/C1/p1',
          },
        ],
        forgotten: { count: 1, lastBy: 'U3', lastAt: '2026-10-05T00:00:00Z' },
        limit: 50,
      }),
    );
    expect(json).toContain('&lt;!here&gt; &amp; &lt;b&gt;');
    expect(json).not.toContain('javascript');
    expect(json).toContain('"value":"C1:abc123"');
    expect(json).toContain('said by <@U2>');
    expect(json).toContain('1 forgotten');
  });
});

describe('admin surface (stage 3)', () => {
  it('admins only from this team; files go to the DM through the external upload flow', async () => {
    const api = new FakeSlack({
      'users.info': (a) => ({
        ok: true,
        user: {
          is_admin: a.user === 'U0ADM',
          team_id: a.user === 'U0EXT' ? 'T9' : 'T1',
          ...(a.user === 'U0EXT' ? { is_admin: true } : {}),
        },
      }),
      'conversations.open': () => ({ ok: true, channel: { id: 'D0ADM' } }),
      'files.getUploadURLExternal': () => ({
        ok: true,
        upload_url: 'https://files.slack.com/upload/v1/abc',
        file_id: 'F1',
      }),
    });
    const posted: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: new TextDecoder().decode(init.body as Uint8Array) });
      return new Response('OK');
    }) as unknown as typeof fetch;
    const s = new SlackSurface(api, { teamId: 'T1', fetchImpl });
    expect(await s.isWorkspaceAdmin('U0ADM')).toBe(true);
    expect(await s.isWorkspaceAdmin('U0ALEX')).toBe(false);
    expect(await s.isWorkspaceAdmin('U0EXT')).toBe(false);
    const r = await s.sendFile('U0ADM', { name: 'l.csv', title: 'Ledger', content: 'a,b\n' });
    expect(r.ok).toBe(true);
    expect(posted).toEqual([{ url: 'https://files.slack.com/upload/v1/abc', body: 'a,b\n' }]);
    const done = api.calls.find((x) => x.method === 'files.completeUploadExternal')!;
    expect(done.args).toMatchObject({
      channel_id: 'D0ADM',
      files: [{ id: 'F1', title: 'Ledger' }],
    });

    const evil = new SlackSurface(
      new FakeSlack({
        'conversations.open': () => ({ ok: true, channel: { id: 'D1' } }),
        'files.getUploadURLExternal': () => ({
          ok: true,
          upload_url: 'https://evil.example/x',
          file_id: 'F',
        }),
      }),
      { teamId: 'T1', fetchImpl },
    );
    expect((await evil.sendFile('U1', { name: 'x', title: 'x', content: 'x' })).ok).toBe(false);
    expect(posted).toHaveLength(1);
  });
});
