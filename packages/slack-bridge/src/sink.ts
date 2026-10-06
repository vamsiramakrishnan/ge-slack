import { toSlackMetadata, type TaskUpdate } from '@ge-slack/contracts';
import type {
  AnswerView,
  AwaitingView,
  MemoryView,
  AutomationPlanView,
  ConnectView,
  LandedView,
  NoticeKind,
  PlanView,
  TurnSink,
} from '@ge-slack/runtime';
import {
  answerBlocks,
  awaitingBlocks,
  memoryBlocks,
  automationPlanBlocks,
  connectBlocks,
  landedBlocks,
  noticeBlocks,
  planBlocks,
  executingBlocks,
  progressBlocks,
  type RenderOptions,
  type Block,
} from './blocks.js';
import { must, slackErrorCode, type SlackApi } from './slack-api.js';

/** POST to a Slack `response_url` (ephemeral replies for slash commands and shortcuts). */
export type ResponsePoster = (url: string, body: Record<string, unknown>) => Promise<void>;

export type SinkTarget =
  /** Public, in a conversation thread (app mentions) or the agent DM: streamed. */
  | {
      mode: 'stream';
      channel: string;
      threadTs?: string;
      userId: string;
      teamId: string;
      agentSession?: boolean;
      /** Root message text when there is no thread yet (streaming needs a thread outside sessions). */
      anchorText?: string;
    }
  /** Only visible to the invoker (slash / shortcuts / modal): ephemeral via response_url or postEphemeral. */
  | {
      mode: 'ephemeral';
      channel: string;
      threadTs?: string;
      userId: string;
      responseUrl?: string;
      /**
       * A button click on a card: `response_url` replaces that card in place (approval card →
       * live receipt). `response_type` is omitted so the card keeps its visibility.
       */
      card?: boolean;
    }
  /** Unattended: plans and outcomes go to the owner's DM; answers to the destination. */
  | { mode: 'unattended'; ownerId: string; destination: string; threadTs?: string };

const FLUSH_CHARS = 400;
const FLUSH_MS = 300;

/**
 * Renders a runtime turn with Slack's materials. Streaming uses `chat.startStream` /
 * `appendStream` / `stopStream` with `task_display_mode: "plan"` so the grounding steps appear
 * as a native plan block; blocks (citations, identity, actions, feedback) attach at stop. If the
 * streaming API is unavailable, it degrades to `chat.postMessage` + throttled `chat.update`.
 */
export class SlackTurnSink implements TurnSink {
  private title = 'Gemini';
  private tasks = new Map<string, TaskUpdate>();
  private streamTs: string | undefined;
  private streamChannel: string | undefined;
  private streamingUnavailable = false;
  private fallbackTs: string | undefined;
  private buffer = '';
  private text = '';
  private lastFlush = 0;
  private progressSent = false;
  private anchorTs: string | undefined;
  private finished = false;

  constructor(
    private readonly api: SlackApi,
    private readonly target: SinkTarget,
    private readonly postResponse: ResponsePoster = defaultResponsePoster,
    private readonly now: () => number = Date.now,
  ) {}

  // ------------------------------------------------------------------ lifecycle

  async begin(title: string): Promise<void> {
    this.title = title;
    const t = this.target;
    if (t.mode === 'stream' && t.agentSession && t.threadTs) {
      await this.safe('agents.sessions.setStatus', {
        channel_id: t.channel,
        thread_ts: t.threadTs,
        status: 'processing',
        title: title.slice(0, 80),
      });
    }
  }

  async task(u: TaskUpdate): Promise<void> {
    this.tasks.set(u.id, u);
    const t = this.target;
    if (t.mode === 'stream') {
      await this.ensureStream();
      if (this.streamTs) {
        await this.append([
          {
            type: 'task_update',
            id: u.id,
            title: u.title.slice(0, 256),
            status: u.status,
            ...(u.details ? { details: u.details.slice(0, 256) } : {}),
          },
        ]);
      } else {
        await this.updateFallback();
      }
    } else if (t.mode === 'ephemeral' && !this.progressSent && u.status === 'in_progress') {
      // response_url allows 5 uses; spend one on a single progress card.
      this.progressSent = true;
      await this.ephemeral(progressBlocks(this.title, [...this.tasks.values()]), 'Working…', true);
    }
  }

  async token(text: string): Promise<void> {
    this.text += text;
    if (this.target.mode !== 'stream') return;
    this.buffer += text;
    if (this.buffer.length >= FLUSH_CHARS || this.now() - this.lastFlush >= FLUSH_MS)
      await this.flush();
  }

  async answer(a: AnswerView): Promise<void> {
    const t = this.target;
    if (t.mode === 'stream') {
      await this.flush();
      const metadata = a.provenance ? toSlackMetadata(a.provenance) : undefined;
      if (this.streamTs) {
        await this.stop(answerBlocks(a, { includeText: false }), metadata);
      } else {
        await this.finalFallback(answerBlocks(a, { includeText: true }), a.text, metadata);
      }
      await this.idle();
    } else if (t.mode === 'ephemeral') {
      await this.ephemeral(answerBlocks(a, { includeText: true }), a.text.slice(0, 3000), true);
    } else {
      await must(this.api, 'chat.postMessage', {
        channel: t.destination,
        ...(t.threadTs ? { thread_ts: t.threadTs } : {}),
        text: a.text.slice(0, 3000),
        blocks: answerBlocks({ ...a, shareable: false, followUps: false }, { includeText: true }),
        unfurl_links: false,
      });
    }
    this.finished = true;
  }

  async plan(p: PlanView): Promise<void> {
    await this.closeStreamWith([]);
    const text = `${p.title} — approve or cancel`;
    const t = this.target;
    await withRichFallback(
      (opts) => planBlocks(p, opts),
      async (blocks) => {
        if (t.mode === 'stream') {
          await must(this.api, 'chat.postMessage', {
            channel: t.channel,
            ...(this.thread() ? { thread_ts: this.thread() } : {}),
            text,
            blocks,
            unfurl_links: false,
          });
        } else if (t.mode === 'ephemeral') {
          await this.ephemeral(blocks, text, true);
        } else {
          await must(this.api, 'chat.postMessage', {
            channel: t.ownerId,
            text: `An automation needs your approval: ${text}`,
            blocks,
            unfurl_links: false,
          });
        }
      },
    );
    await this.idle();
  }

  async executing(p: PlanView): Promise<void> {
    // Only a clicked card turns into a live receipt; other surfaces just get the final receipt.
    const t = this.target;
    if (t.mode !== 'ephemeral' || !t.card || !t.responseUrl) return;
    await withRichFallback(
      (opts) => executingBlocks(p, opts),
      (blocks) => this.ephemeral(blocks, 'Applying changes…', true),
    ).catch(() => undefined); // progress is best effort; the final receipt still lands
  }

  async automationPlan(p: AutomationPlanView): Promise<void> {
    await this.closeStreamWith([]);
    await this.private(automationPlanBlocks(p), 'Create this automation?');
  }

  async connect(c: ConnectView): Promise<void> {
    await this.closeStreamWith([]);
    // Connect prompts are always private to the person who has to act on them.
    await this.private(connectBlocks(c), 'Connect Gemini Enterprise');
    await this.idle();
  }

  async memory(m: MemoryView): Promise<void> {
    await this.closeStreamWith([]);
    const text = `Channel memory: ${m.notes.length} notes`;
    if (this.target.mode === 'unattended') return;
    if (this.target.mode === 'ephemeral')
      await this.ephemeral(memoryBlocks(m), text, !this.target.card);
    else await this.private(memoryBlocks(m), text);
    await this.idle();
  }

  async awaiting(a: AwaitingView): Promise<void> {
    await this.closeStreamWith([]);
    const text = `${a.agentTitle} is waiting for you`;
    if (this.target.mode === 'unattended') {
      await must(this.api, 'chat.postMessage', { channel: this.target.ownerId, text });
    } else if (this.target.mode === 'ephemeral') {
      // A new private message: never replace the answer (e.g. the research plan) it refers to.
      await this.ephemeral(awaitingBlocks(a), text, false);
    } else {
      // Continuing is the invoker's call alone, so the controls are private to them.
      await this.private(awaitingBlocks(a), text);
    }
    await this.idle();
  }

  async landed(l: LandedView): Promise<void> {
    await this.closeStreamWith([]);
    const t = this.target;
    const invoker = t.mode === 'unattended' ? t.ownerId : t.userId;
    const text = `Applied ${l.results.filter((r) => r.outcome === 'applied').length}/${l.results.length} changes`;
    await withRichFallback(
      (opts) => landedBlocks(l, invoker, opts),
      async (blocks) => {
        if (t.mode === 'unattended') {
          await must(this.api, 'chat.postMessage', { channel: t.ownerId, text, blocks });
        } else {
          await this.private(blocks, text);
        }
      },
    );
  }

  async notice(kind: NoticeKind, text: string): Promise<void> {
    const t = this.target;
    const blocks = noticeBlocks(kind, text);
    if (t.mode === 'ephemeral' && t.card && t.responseUrl) {
      // Never replace a (possibly shared) card with a notice: the clicker alone sees it (M5).
      await this.postResponse(t.responseUrl, {
        response_type: 'ephemeral',
        replace_original: false,
        text: text.slice(0, 3000),
        blocks,
      });
    } else if (t.mode === 'stream' && (this.streamTs || this.fallbackTs)) {
      await this.flush();
      await this.closeStreamWith(blocks);
    } else if (t.mode === 'unattended') {
      await must(this.api, 'chat.postMessage', { channel: t.ownerId, text, blocks });
    } else {
      await this.private(blocks, text);
    }
    await this.idle();
    this.finished = true;
  }

  async retire(text: string): Promise<void> {
    const t = this.target;
    if (t.mode === 'ephemeral' && t.card && t.responseUrl) {
      await this.ephemeral(noticeBlocks('info', text), text, true);
      return;
    }
    await this.notice('info', text);
  }

  // ------------------------------------------------------------------ streaming internals

  /** The thread this turn renders in (given, or the anchor we created). */
  private thread(): string | undefined {
    const t = this.target;
    return t.mode === 'unattended' ? t.threadTs : (t.threadTs ?? this.anchorTs);
  }

  private async ensureStream(): Promise<void> {
    const t = this.target;
    if (t.mode !== 'stream' || this.streamTs || this.fallbackTs) return;
    if (!t.threadTs && !this.anchorTs && !t.agentSession) {
      // chat.startStream requires a thread outside session channels: anchor one visibly.
      const root = await must(this.api, 'chat.postMessage', {
        channel: t.channel,
        text: t.anchorText ?? `✦ <@${t.userId}> asked Gemini: ${this.title}`,
      });
      this.anchorTs = root.ts as string;
    }
    if (!this.streamingUnavailable) {
      try {
        const thread = this.thread();
        const r = await must(this.api, 'chat.startStream', {
          channel: t.channel,
          ...(thread ? { thread_ts: thread } : {}),
          recipient_user_id: t.userId,
          recipient_team_id: t.teamId,
          task_display_mode: 'plan',
          chunks: [{ type: 'plan_update', title: this.title.slice(0, 256) }],
        });
        this.streamTs = r.ts as string;
        this.streamChannel = (r.channel as string) ?? t.channel;
        return;
      } catch {
        this.streamingUnavailable = true;
      }
    }
    const thread = this.thread();
    const r = await must(this.api, 'chat.postMessage', {
      channel: t.channel,
      ...(thread ? { thread_ts: thread } : {}),
      text: this.title,
      blocks: progressBlocks(this.title, [...this.tasks.values()]),
    });
    this.fallbackTs = r.ts as string;
    this.streamChannel = (r.channel as string) ?? t.channel;
  }

  private async append(chunks: Array<Record<string, unknown>>): Promise<void> {
    if (!this.streamTs) return;
    await must(this.api, 'chat.appendStream', {
      channel: this.streamChannel,
      ts: this.streamTs,
      chunks,
    });
  }

  private async flush(): Promise<void> {
    if (!this.buffer || this.target.mode !== 'stream') return;
    await this.ensureStream();
    const text = this.buffer;
    this.buffer = '';
    this.lastFlush = this.now();
    if (this.streamTs) await this.append([{ type: 'markdown_text', text }]);
    else await this.updateFallback();
  }

  private async stop(blocks: Block[], metadata?: Record<string, unknown>): Promise<void> {
    if (!this.streamTs) return;
    const t = this.target;
    await must(this.api, 'chat.stopStream', {
      channel: this.streamChannel,
      ts: this.streamTs,
      ...(blocks.length ? { blocks } : {}),
      // Streamed answers carry the same durable provenance as writes.
      ...(metadata ? { metadata } : {}),
      ...(t.mode === 'stream' && t.agentSession ? { session_status: 'active' } : {}),
    });
    this.streamTs = undefined;
  }

  private async closeStreamWith(blocks: Block[]): Promise<void> {
    if (this.streamTs) await this.stop(blocks);
    else if (this.fallbackTs)
      await this.finalFallback(
        [...progressBlocks(this.title, [...this.tasks.values()]), ...blocks],
        this.title,
      );
  }

  private async updateFallback(): Promise<void> {
    if (!this.fallbackTs) return;
    if (this.now() - this.lastFlush < 1000 && this.text) return; // chat.update is rate limited
    this.lastFlush = this.now();
    await this.safe('chat.update', {
      channel: this.streamChannel,
      ts: this.fallbackTs,
      text: this.text || this.title,
      blocks: [
        ...progressBlocks(this.title, [...this.tasks.values()]),
        ...(this.text ? [{ type: 'markdown', text: this.text.slice(-2900) }] : []),
      ],
    });
  }

  private async finalFallback(
    blocks: Block[],
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const t = this.target;
    if (t.mode !== 'stream') return;
    if (this.fallbackTs) {
      await must(this.api, 'chat.update', {
        channel: this.streamChannel,
        ts: this.fallbackTs,
        text: text.slice(0, 3000),
        blocks,
        ...(metadata ? { metadata } : {}),
      });
      this.fallbackTs = undefined;
    } else {
      const thread = this.thread();
      await must(this.api, 'chat.postMessage', {
        channel: t.channel,
        ...(thread ? { thread_ts: thread } : {}),
        text: text.slice(0, 3000),
        blocks,
        unfurl_links: false,
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  private async idle(): Promise<void> {
    const t = this.target;
    if (t.mode === 'stream' && t.agentSession && t.threadTs) {
      await this.safe('agents.sessions.setStatus', {
        channel_id: t.channel,
        thread_ts: t.threadTs,
        status: 'active',
      });
    }
  }

  // ------------------------------------------------------------------ private delivery

  private async private(blocks: Block[], text: string): Promise<void> {
    const t = this.target;
    if (t.mode === 'ephemeral') return this.ephemeral(blocks, text, true);
    if (t.mode === 'unattended') {
      await must(this.api, 'chat.postMessage', { channel: t.ownerId, text, blocks });
      return;
    }
    if (t.agentSession) {
      // The agent DM is already private to this user.
      await must(this.api, 'chat.postMessage', {
        channel: t.channel,
        ...(this.thread() ? { thread_ts: this.thread() } : {}),
        text,
        blocks,
      });
      return;
    }
    await must(this.api, 'chat.postEphemeral', {
      channel: t.channel,
      user: t.userId,
      ...(this.thread() ? { thread_ts: this.thread() } : {}),
      text,
      blocks,
    });
  }

  private async ephemeral(blocks: Block[], text: string, replace: boolean): Promise<void> {
    const t = this.target;
    if (t.mode !== 'ephemeral') return;
    if (t.responseUrl) {
      await this.postResponse(t.responseUrl, {
        // Updating a clicked card keeps its visibility; Slack forbids changing response_type.
        ...(t.card ? {} : { response_type: 'ephemeral' }),
        replace_original: replace,
        text: text.slice(0, 3000),
        blocks,
      });
      return;
    }
    await must(this.api, 'chat.postEphemeral', {
      channel: t.channel,
      user: t.userId,
      ...(t.threadTs ? { thread_ts: t.threadTs } : {}),
      text: text.slice(0, 3000),
      blocks,
    });
  }

  private async safe(method: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.api.call(method, args);
    } catch {
      /* best-effort UI affordance */
    }
  }

  get done(): boolean {
    return this.finished;
  }
}

export const defaultResponsePoster: ResponsePoster = async (url, body) => {
  // response_url is a Slack-issued hooks.slack.com URL; refuse anything else (SSRF guard).
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com')
    throw new Error('refusing non-Slack response_url');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Slack answers "ok", or an error code such as "invalid_blocks" in the body.
  const detail = (await res.text().catch(() => '')).slice(0, 100);
  if (!res.ok || /invalid_blocks|"ok"\s*:\s*false/.test(detail)) {
    throw new Error(`response_url failed (${res.status}): ${detail}`);
  }
};

function isInvalidBlocks(err: unknown): boolean {
  const code = slackErrorCode(err);
  if (code) return /invalid_blocks|invalid_block|unsupported/.test(code);
  return err instanceof Error && /invalid_blocks|invalid_block|unsupported/.test(err.message);
}

/**
 * Render with Slack's newest blocks first; if Slack rejects them (older workspace/client gating,
 * or a block not yet allowed on this surface), resend the same content with classic blocks.
 */
export async function withRichFallback(
  build: (opts: RenderOptions) => Block[],
  send: (blocks: Block[]) => Promise<void>,
): Promise<void> {
  try {
    await send(build({ rich: true }));
  } catch (err) {
    if (!isInvalidBlocks(err)) throw err;
    await send(build({ rich: false }));
  }
}
