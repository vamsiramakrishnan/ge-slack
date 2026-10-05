import type {
  ActuationRequest,
  ActuationResult,
  AssistEvent,
  Inverse,
  TaskUpdate,
} from '@ge-slack/contracts';
import type { AssistTurn, TokenSource } from '@ge-slack/gemini-client';
import type {
  AnswerView,
  AutomationPlanView,
  CapturedContext,
  ConnectView,
  ConversationInfo,
  GeminiPort,
  LandedView,
  NoticeKind,
  PlanView,
  ResolvedScope,
  SurfacePort,
  TurnSink,
} from './ports.js';

/** Test doubles shared by runtime/automations/app tests. Labelled fakes — not Slack evidence. */
export class RecordingSink implements TurnSink {
  events: Array<{ type: string; value: unknown }> = [];
  tokens = '';
  async begin(title: string) {
    this.events.push({ type: 'begin', value: title });
  }
  async task(t: TaskUpdate) {
    this.events.push({ type: 'task', value: t });
  }
  async token(text: string) {
    this.tokens += text;
  }
  async answer(a: AnswerView) {
    this.events.push({ type: 'answer', value: a });
  }
  async plan(p: PlanView) {
    this.events.push({ type: 'plan', value: p });
  }
  async automationPlan(p: AutomationPlanView) {
    this.events.push({ type: 'automationPlan', value: p });
  }
  async connect(c: ConnectView) {
    this.events.push({ type: 'connect', value: c });
  }
  async landed(l: LandedView) {
    this.events.push({ type: 'landed', value: l });
  }
  async notice(kind: NoticeKind, text: string) {
    this.events.push({ type: 'notice', value: { kind, text } });
  }
  last<T = unknown>(type: string): T | undefined {
    return [...this.events].reverse().find((e) => e.type === type)?.value as T | undefined;
  }
}

export class FakeSurface implements SurfacePort {
  members = new Map<string, Set<string>>();
  info = new Map<string, ConversationInfo>();
  contexts = new Map<string, CapturedContext>();
  actuated: ActuationRequest[] = [];
  undone: Inverse[] = [];
  failKinds = new Set<string>();
  private n = 0;

  async conversationInfo(channel: string): Promise<ConversationInfo> {
    return (
      this.info.get(channel) ?? {
        id: channel,
        name: channel.toLowerCase(),
        isPrivate: false,
        isIm: false,
        isExtShared: false,
      }
    );
  }
  async isMember(channel: string, userId: string) {
    return this.members.get(channel)?.has(userId) ?? false;
  }
  async capture(scope: ResolvedScope): Promise<CapturedContext> {
    const key =
      scope.kind === 'thread' || scope.kind === 'message'
        ? `${scope.channel}:${scope.ts}`
        : scope.kind === 'none'
          ? 'none'
          : scope.kind === 'canvas'
            ? scope.id
            : scope.channel;
    return structuredClone(
      this.contexts.get(key) ?? { label: key, messages: [], truncated: false },
    );
  }
  async actuate(req: ActuationRequest): Promise<ActuationResult> {
    this.actuated.push(req);
    if (this.failKinds.has(req.params.kind)) throw new Error('socket hang up');
    const ts = `1800000000.${String(++this.n).padStart(6, '0')}`;
    const channel = 'channel' in req.params ? req.params.channel : 'D0BOT';
    return {
      changeId: req.changeId,
      kind: req.params.kind,
      outcome: 'applied',
      location: {
        channel,
        ts,
        permalink: `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}`,
      },
      inverse: { op: 'delete-message', channel, ts },
      provenancePersisted: true,
    };
  }
  async undo(inverse: Inverse) {
    this.undone.push(inverse);
    return { ok: true, message: 'Undone.' };
  }
  async userEmail() {
    return 'alex@acme.com';
  }
}

/** Scripted Gemini: each call pops the next response text (or a custom event list). */
export class FakeGemini implements GeminiPort {
  turns: AssistTurn[] = [];
  constructor(public script: Array<string | AssistEvent[]>) {}
  async *stream(_tokens: TokenSource, turn: AssistTurn): AsyncIterable<AssistEvent> {
    this.turns.push(turn);
    const next = this.script.shift() ?? '';
    if (Array.isArray(next)) {
      yield* next;
      return;
    }
    for (const part of next.match(/[\s\S]{1,40}/g) ?? []) yield { type: 'token', text: part };
    yield { type: 'citation', source: { title: 'Runbook', uri: 'https://docs.acme.com/runbook' } };
    yield {
      type: 'provenance',
      payload: {
        agentId: 'gemini-enterprise:eng',
        identity: turn.identity,
        timestamp: 't',
        sources: [{ title: 'Runbook' }],
        contentHash: 'h',
      },
    };
    yield { type: 'done' };
  }
}
