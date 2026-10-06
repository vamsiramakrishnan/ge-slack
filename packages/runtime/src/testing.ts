import type {
  ActuationRequest,
  ActuationResult,
  AssistEvent,
  Inverse,
  TaskUpdate,
} from '@ge-slack/contracts';
import type { AssistTurn, TokenSource } from '@ge-slack/gemini-client';
import type {
  MemoryView,
  AwaitingView,
  AnswerView,
  AutomationPlanView,
  CapturedContext,
  ConnectView,
  ConversationInfo,
  GeminiPort,
  LandedView,
  LicenceRequestView,
  LicenceView,
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
  async licence(l: LicenceView) {
    this.events.push({ type: 'licence', value: l });
  }
  async executing(p: PlanView) {
    this.events.push({ type: 'executing', value: p });
  }
  async landed(l: LandedView) {
    this.events.push({ type: 'landed', value: l });
  }
  async retire(text: string) {
    this.events.push({ type: 'notice', value: { kind: 'info', text } });
  }
  async notice(kind: NoticeKind, text: string) {
    this.events.push({ type: 'notice', value: { kind, text } });
  }
  async awaiting(a: AwaitingView) {
    this.events.push({ type: 'awaiting', value: a });
  }
  async memory(m: MemoryView) {
    this.events.push({ type: 'memory', value: m });
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
  guests = new Set<string>();
  searches: Array<{ query?: string; actionToken?: string }> = [];
  async isGuest(userId: string) {
    return this.guests.has(userId);
  }
  async capture(
    scope: ResolvedScope,
    opts: { search?: string; actionToken?: string } = {},
  ): Promise<CapturedContext> {
    if (scope.kind === 'search') {
      this.searches.push({
        ...(opts.search ? { query: opts.search } : {}),
        ...(opts.actionToken ? { actionToken: opts.actionToken } : {}),
      });
      return structuredClone(
        this.contexts.get(`search:${scope.query}`) ?? {
          label: 'search',
          messages: [],
          truncated: false,
        },
      );
    }
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
  canvases = new Map<string, string[]>();
  async canvasAccess(id: string) {
    const channels = this.canvases.get(id);
    return { isCanvas: channels !== undefined, channels: channels ?? [] };
  }
  async userEmail() {
    return 'alex@acme.com';
  }
  dms: Array<{ userId: string; text: string; link?: { channel: string; ts: string } }> = [];
  async notifyUser(userId: string, msg: { text: string; link?: { channel: string; ts: string } }) {
    this.dms.push({ userId, ...msg });
  }
  admins = new Set<string>();
  files: Array<{ userId: string; name: string; content: string }> = [];
  async isWorkspaceAdmin(userId: string) {
    return this.admins.has(userId);
  }
  async sendFile(userId: string, file: { name: string; title: string; content: string }) {
    this.files.push({ userId, name: file.name, content: file.content });
    return { ok: true, message: 'Sent to your DM.' };
  }
  licenceCards: Array<{ channel: string; view: LicenceRequestView; ts?: string }> = [];
  async licenceRequestCard(channel: string, view: LicenceRequestView, ts?: string) {
    this.licenceCards.push({ channel, view, ...(ts ? { ts } : {}) });
    return { channel, ts: ts ?? `card.${this.licenceCards.length}` };
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
