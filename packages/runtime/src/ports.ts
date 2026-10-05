import type {
  ActuationRequest,
  ActuationResult,
  ApprovalClass,
  AssistEvent,
  Automation,
  ChannelPolicy,
  GroundSource,
  Inverse,
  Invocation,
  Origin,
  PrincipalDecision,
  ResearchUnit,
  SourceRef,
  TaskUpdate,
  Trigger,
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
    opts: { from: string[]; maxMessages: number; search?: string },
  ): Promise<CapturedContext>;
  actuate(req: ActuationRequest): Promise<ActuationResult>;
  undo(inverse: Inverse): Promise<{ ok: boolean; message: string }>;
  /** Is this file a canvas, and which conversations is it shared in? (canvas membership gate) */
  canvasAccess(id: string): Promise<{ isCanvas: boolean; channels: string[] }>;
  userEmail(userId: string): Promise<string | undefined>;
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
}

export interface PlanEffectView {
  index: number;
  kind: ActuationRequest['params']['kind'];
  label: string;
  /** Short human preview of what will land. */
  preview: string;
  approvalClass: ApprovalClass;
  reversible: boolean;
  line: string;
}

export interface PlanView {
  planId: string;
  title: string;
  grammar: string;
  effects: PlanEffectView[];
  identity: IdentityBadge;
  invokerId: string;
  steps: string[];
  dryRun: boolean;
  expiresAt: string;
  sources: SourceRef[];
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
  results: Array<{
    changeId: string;
    label: string;
    outcome: ActuationResult['outcome'];
    permalink?: string;
    undoable: boolean;
    error?: string;
  }>;
  identity: IdentityBadge;
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
  landed(l: LandedView): Promise<void>;
  notice(kind: NoticeKind, text: string): Promise<void>;
}

export interface LinkStarter {
  /** Start account linking and return the IdP URL. */
  start(p: { teamId: string; slackUserId: string; resumeId?: string }): Promise<string>;
  providerName: string;
}

export type { PrincipalDecision, Invocation, Origin };
