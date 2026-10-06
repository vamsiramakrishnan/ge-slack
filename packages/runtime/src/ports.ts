import type {
  AgentEntry,
  ConnectorEntry,
  AwaitingReason,
  ActuationRequest,
  ActuationResult,
  ApprovalClass,
  AssistEvent,
  Automation,
  ChannelPolicy,
  GroundSource,
  Intent,
  Inverse,
  Invocation,
  Origin,
  PrincipalDecision,
  ResearchUnit,
  SourceRef,
  TaskUpdate,
  TelemetryEvent,
  InsightsSummary,
  Trigger,
  WriteProvenance,
} from '@ge-slack/contracts';
import type { AssistTurn, TokenSource } from '@ge-slack/gemini-client';
import type { Resolved, ResolveInput } from '@ge-slack/identity';

/** A message captured from Slack, already reduced to what the model may see. */
export interface CapturedMessage {
  ts: string;
  /** Conversation the message lives in (defaults to the context's channel). */
  channel?: string;
  user?: string;
  /** Display name resolved by the bridge; may be absent. */
  author?: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
  permalink?: string;
  /** True for messages posted by this app (so the model can tell its own output apart). */
  fromApp?: boolean;
}

export interface CapturedContext {
  /** Fixed human label, e.g. "#eng-incidents · last 7 days". */
  label: string;
  channel?: string;
  threadTs?: string;
  messages: CapturedMessage[];
  canvas?: { id: string; title: string; markdown: string };
  /** Hit the capture budget; older content was not read. */
  truncated: boolean;
}

/** A scope with its refs filled in from the origin. */
export type ResolvedScope =
  | { kind: 'thread'; channel: string; ts: string }
  | { kind: 'channel'; channel: string; sinceMs: number }
  | { kind: 'message'; channel: string; ts: string }
  | { kind: 'canvas'; id: string; channel?: string }
  | { kind: 'dm'; channel: string }
  /** Workspace search (Real-time Search) when an action token exists; else a keyword filter of `channel`. */
  | { kind: 'search'; channel: string; query: string; sinceMs: number }
  | { kind: 'none' };

export interface ConversationInfo {
  id: string;
  name?: string;
  isPrivate: boolean;
  isIm: boolean;
  isExtShared: boolean;
}

/** Slack-side operations. Implemented by `@ge-slack/slack-bridge` — the only Slack API caller. */
export interface SurfacePort {
  conversationInfo(channel: string): Promise<ConversationInfo>;
  /** Is this human a member of the conversation? (Bot membership is never authority.) */
  isMember(channel: string, userId: string): Promise<boolean>;
  capture(
    scope: ResolvedScope,
    opts: {
      from: string[];
      maxMessages: number;
      search?: string;
      /** Slack's per-event `action_token`, required for Real-time Search with a bot token. */
      actionToken?: string;
    },
  ): Promise<CapturedContext>;
  /** Guests (single/multi-channel) can't search the workspace. */
  isGuest(userId: string): Promise<boolean>;
  actuate(req: ActuationRequest): Promise<ActuationResult>;
  undo(inverse: Inverse): Promise<{ ok: boolean; message: string }>;
  /** Is this file a canvas, and which conversations is it shared in? (canvas membership gate) */
  canvasAccess(id: string): Promise<{ isCanvas: boolean; channels: string[] }>;
  userEmail(userId: string): Promise<string | undefined>;
  /** Workspace admin/owner of this team (insights, ledger export). Fails closed. */
  isWorkspaceAdmin(userId: string): Promise<boolean>;
  /** DM one person a short notice, optionally linking a message (job finished). */
  notifyUser(
    userId: string,
    msg: { text: string; link?: { channel: string; ts: string } },
  ): Promise<void>;
  /** DM one person a file (ledger export). */
  sendFile(
    userId: string,
    file: { name: string; title: string; content: string; comment?: string },
  ): Promise<{ ok: boolean; message: string }>;
}

export interface GeminiPort {
  stream(tokens: TokenSource, turn: AssistTurn): AsyncIterable<AssistEvent>;
}

export interface IdentityPort {
  resolve(input: ResolveInput): Promise<Resolved>;
  readonly serviceConfigured: boolean;
  readonly serviceAccount: string | undefined;
  getLinked(
    teamId: string,
    userId: string,
  ): Promise<
    { email: string; provider: string; allowUnattended: boolean; linkedAt: string } | undefined
  >;
  unlink(teamId: string, userId: string): Promise<void>;
  setAllowUnattended(teamId: string, userId: string, allow: boolean): Promise<boolean>;
}

/** Workspace configuration: channel policy, research units, the `@` catalog. */
export interface WorkspaceConfigPort {
  channelPolicy(teamId: string, channel: string): Promise<ChannelPolicy>;
  setChannelPolicy(teamId: string, channel: string, policy: ChannelPolicy): Promise<void>;
  unit(teamId: string, channel: string): Promise<ResearchUnit | undefined>;
  setUnit(teamId: string, channel: string, unit: ResearchUnit): Promise<void>;
  catalog(teamId: string): Promise<GroundSource[]>;
  /** Gemini Enterprise agents addressable with `@alias` (ADR-0002). */
  agents(teamId: string): Promise<AgentEntry[]>;
  /** Connector tools an admin allow-listed for `act` (EXPERIENCE §10). */
  connectors(teamId: string): Promise<ConnectorEntry[]>;
}

/** Gemini Enterprise connector tools (`invokeConnectorMcp`), always as the turn's principal. */
export interface ConnectorPort {
  listTools(
    tokens: TokenSource,
    collection: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(
    tokens: TokenSource,
    collection: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<
    { ok: true; text: string } | { ok: false; code: string; message: string; uncertain?: boolean }
  >;
}

/** Admin insights sink (EXPERIENCE §10). Records carry no content and no user identities. */
export interface TelemetryPort {
  record(teamId: string, e: TelemetryEvent): Promise<void>;
}

export interface InsightsPort {
  summary(teamId: string, days?: number): Promise<InsightsSummary>;
}

export interface AutomationPort {
  create(a: Omit<Automation, 'id' | 'createdAt'>): Promise<Automation>;
  list(teamId: string, ownerId?: string): Promise<Automation[]>;
  nextRun(trigger: Trigger, from: Date): Date | undefined;
}

// ---------------------------------------------------------------- presentation

export interface IdentityBadge {
  kind: 'user' | 'service';
  label: string;
  /** e.g. the Slack Connect coercion notice. */
  notice?: string;
}

export interface AnswerView {
  turnId: string;
  text: string;
  sources: SourceRef[];
  identity: IdentityBadge;
  grounded: boolean;
  related: string[];
  warnings: string[];
  /** Offer Share-to-conversation (private answers in a conversation). */
  shareable: boolean;
  /** Offer "Draft follow-up" (pre-fills the composer with `draft`). */
  followUps: boolean;
  /** Durable provenance for the answer message itself (attached as `ge_provenance` metadata). */
  provenance?: WriteProvenance;
  /** The agent that answered, shown in the footer (e.g. "Deep Research", "Triage bot · A2A"). */
  via?: string;
  /** Some connectors were skipped for lack of authorization: link to Gemini Enterprise. */
  authorizeUrl?: string;
  /** Channel notes that grounded this answer (EXPERIENCE §10). */
  memoryNotes?: number;
}

/** `/gemini memory`: the channel's notes, each with Forget (EXPERIENCE §10). */
export interface MemoryView {
  channel: string;
  notes: Array<{
    n: number;
    id: string;
    text: string;
    author: string;
    at: string;
    permalink?: string;
    sourceUser?: string;
  }>;
  forgotten: { count: number; lastBy?: string; lastAt?: string };
  limit: number;
}

/** An agent paused for the invoker: start a research plan, answer a question, or authorize. */
export interface AwaitingView {
  continuationId: string;
  reason: AwaitingReason;
  agentTitle: string;
  invokerId: string;
  /** Where to authorize connectors/agents (Gemini Enterprise web app; deployment config). */
  authorizeUrl?: string;
}

export interface PlanEffectView {
  index: number;
  changeId: string;
  /** Unticked by the approver (review findings can be posted selectively). */
  skipped: boolean;
  kind: ActuationRequest['params']['kind'];
  label: string;
  /** Short human preview of what will land. */
  preview: string;
  /** Exact payload (connector-action arguments as pretty JSON). */
  detail?: string;
  approvalClass: ApprovalClass;
  reversible: boolean;
  line: string;
}

export interface PlanView {
  planId: string;
  verb: Intent;
  title: string;
  grammar: string;
  effects: PlanEffectView[];
  identity: IdentityBadge;
  invokerId: string;
  steps: string[];
  dryRun: boolean;
  expiresAt: string;
  sources: SourceRef[];
  /** Channel notes that grounded this plan (EXPERIENCE §10). */
  memoryNotes?: number;
}

export interface AutomationPlanView {
  pendingId: string;
  trigger: Trigger;
  grammar: string;
  runAs: 'me' | 'service';
  destination?: string;
  nextRun?: string;
  invokerId: string;
  channelId: string;
}

export interface ConnectView {
  message: string;
  connectUrl?: string;
  providerName: string;
  offerService: boolean;
  serviceSources: string[];
  resumeId?: string;
}

export interface LandedView {
  planId: string;
  title: string;
  results: Array<{
    changeId: string;
    kind: ActuationRequest['params']['kind'];
    label: string;
    outcome: ActuationResult['outcome'];
    permalink?: string;
    undoable: boolean;
    error?: string;
    note?: string;
  }>;
  identity: IdentityBadge;
  /** Findings the approver chose not to post. */
  skipped: number;
}

export type NoticeKind = 'info' | 'warning' | 'error' | 'policy' | 'denied' | 'clarify';

/**
 * Where a turn renders. The Slack bridge implements this for each entry point (streaming thread
 * reply, ephemeral via response_url, agent DM, unattended destination).
 */
export interface TurnSink {
  begin(title: string): Promise<void>;
  task(t: TaskUpdate): Promise<void>;
  token(text: string): Promise<void>;
  answer(a: AnswerView): Promise<void>;
  plan(p: PlanView): Promise<void>;
  automationPlan(p: AutomationPlanView): Promise<void>;
  connect(c: ConnectView): Promise<void>;
  /** Approved: the card switches to a live receipt (every change in progress). */
  executing(p: PlanView): Promise<void>;
  landed(l: LandedView): Promise<void>;
  notice(kind: NoticeKind, text: string): Promise<void>;
  /** The invoker closed the card (cancel / dry run): replace it with a final line. */
  retire(text: string): Promise<void>;
  /** An agent is waiting on the invoker (Deep Research plan, A2A input or authorization). */
  awaiting(a: AwaitingView): Promise<void>;
  /** The channel's memory, privately to the person who asked. */
  memory(m: MemoryView): Promise<void>;
}

export interface LinkStarter {
  /** Start account linking and return the IdP URL. */
  start(p: { teamId: string; slackUserId: string; resumeId?: string }): Promise<string>;
  providerName: string;
}

export type { PrincipalDecision, Invocation, Origin };
