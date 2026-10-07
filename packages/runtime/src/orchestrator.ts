import { randomUUID } from 'node:crypto';
import {
  KIND_LABELS,
  admitAgent,
  canAutoApply,
  isActuating,
  isUnattended,
  parsePlanBlock,
  parseProgram,
  principalLabel,
  renderInvocation,
  type ActuationParams,
  type AgentEntry,
  type AgentHandle,
  type ActuationRequest,
  type ActuationKind,
  type ActuationResult,
  type AvailableConnectorTool,
  type CmdEffect,
  type CmdLine,
  type CommandPlan,
  type Invocation,
  type Origin,
  type AssistEvent,
  type ChannelNote,
  type Feature,
  type TelemetryEvent,
  type ParsedCommand,
  type Principal,
  type SourceRef,
  type WriteProvenance,
} from '@ge-slack/contracts';
import { collectStream, contentHash, type TokenSource } from '@ge-slack/gemini-client';
import { IdentityRevokedError } from '@ge-slack/identity';
import {
  StreamSanitizer,
  mrkdwnEscape,
  compileActionItems,
  compileEffect,
  sanitizeOutbound,
  type CompiledEffect,
} from './compile.js';
import { composeChatPrompt, composeCommandPrompt, composePlannerPrompt } from './prompt.js';
import {
  kindsFor,
  looksActionable,
  resolveGrounds,
  resolveScope,
  scopeChannel,
  type GroundResolution,
} from './resolve.js';
import {
  PLAN_TTL_MS,
  RuntimeStores,
  type AgentContinuation,
  type PendingPlan,
  type StoredAnswer,
} from './stores.js';
import type {
  AutomationPort,
  CapturedContext,
  GeminiPort,
  IdentityBadge,
  IdentityPort,
  LandedView,
  LinkStarter,
  PlanView,
  ResolvedScope,
  ConnectorPort,
  InsightsPort,
  SurfacePort,
  TelemetryPort,
  TurnSink,
  WorkspaceConfigPort,
} from './ports.js';
import { notesFor } from './memory.js';
import { observingSink } from './insights.js';
import { runAsJob, type JobStore } from './jobs.js';
import { handleControl } from './controls.js';
import {
  licenceGate,
  licenceOnForbidden,
  licenceServiceGuard,
  type LicenceService,
} from './licence.js';

export interface OrchestratorDeps {
  surface: SurfacePort;
  gemini: GeminiPort;
  identity: IdentityPort;
  config: WorkspaceConfigPort;
  stores: RuntimeStores;
  automations?: AutomationPort;
  linker?: LinkStarter;
  now?: () => Date;
  newId?: () => string;
  timeZone?: string;
  maxMessages?: number;
  maxExecutorTurns?: number;
  maxEffects?: number;
  /** Gemini Enterprise web app, where people authorize connectors and agents (deep link). */
  appUrl?: string;
  /** Stage-3 features switched on for this deployment (`GE_FEATURES`). */
  features?: ReadonlySet<Feature>;
  /** Build identifier shown by `/gemini diag` (e.g. the git sha / Cloud Run revision). */
  version?: string;
  telemetry?: TelemetryPort;
  insights?: InsightsPort;
  jobs?: JobStore;
  connectors?: ConnectorPort;
  /** Licence-aware onboarding (EXPERIENCE §11); used with the `licences` feature. */
  licences?: LicenceService;
}

type Turn = {
  principal: Principal;
  tokens: TokenSource;
  identity: string;
  badge: IdentityBadge;
  scope: ResolvedScope;
  grounds: GroundResolution;
  ctx: CapturedContext | undefined;
  allowedChannels: Set<string>;
  readChannels: Set<string>;
  externallyShared: boolean;
  /** The `@agent` this turn addresses, if any (ADR-0002). */
  agent?: AgentEntry;
  /** False when captured Slack content must not be sent (A2A agent, scope not named). */
  forwardContext: boolean;
  /** Channel notes grounding this turn (EXPERIENCE §10). */
  memory: ChannelNote[];
  /** Aborted by Slack's stop button (`agent_session_stopped`). */
  signal?: AbortSignal;
  /** "Answer with the Gemini service" may be offered if this person turns out to be unlicensed. */
  serviceFallback: boolean;
};

/** How long a paused agent (research plan, A2A question) waits for its invoker. */
export const AGENT_CONTINUATION_TTL_MS = 60 * 60_000;

export interface RunOptions {
  signal?: AbortSignal;
  /** Slack's per-event action token (enables Real-time Search). Never persisted. */
  actionToken?: string;
}

export type HandleResult = { kind: 'compose' } | { kind: 'done' };

/**
 * The one dispatcher every entry point calls (ge-msft ADR-0015 shared dispatch). Sequencing:
 * principal → membership gate → grounds → capture → chat stream | plan → approval → actuation →
 * ledger. Surface-agnostic: Slack specifics live behind `SurfacePort` and `TurnSink`.
 */
export class Orchestrator {
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** tools/list results per principal + connector, briefly (discovery runs on every draft). */
  private readonly toolCache = new Map<
    string,
    { tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; until: number }
  >();

  constructor(readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 20));
  }

  /**
   * Admin insights (no content, no user identities). Best effort: telemetry never fails a turn,
   * and only runs with the `analytics` feature.
   */
  observe(teamId: string, e: TelemetryEvent): void {
    if (!this.deps.features?.has('analytics') || !this.deps.telemetry) return;
    void this.deps.telemetry.record(teamId, e).catch(() => undefined);
  }

  async handle(
    parsed: ParsedCommand,
    origin: Origin,
    sink: TurnSink,
    opts: RunOptions = {},
  ): Promise<HandleResult> {
    switch (parsed.kind) {
      case 'compose':
        return { kind: 'compose' };
      case 'error':
        await sink.notice(
          'error',
          parsed.hint ? `${parsed.message}\n_${parsed.hint}_` : parsed.message,
        );
        return { kind: 'done' };
      case 'control':
        await handleControl(this, parsed.verb, parsed.args, origin, sink);
        return { kind: 'done' };
      case 'automate':
        await this.draftAutomation(parsed.trigger, parsed.invocation, origin, sink);
        return { kind: 'done' };
      case 'invoke':
        await this.run(parsed.invocation, origin, sink, parsed.warnings, opts);
        return { kind: 'done' };
    }
  }

  /** Run one invocation end to end. Never throws to the caller; failures render as notices. */
  async run(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    warnings: string[] = [],
    opts: RunOptions = {},
  ): Promise<void> {
    sink = observingSink(this, origin.teamId, { verb: inv.verb, entry: origin.entry }, sink);
    try {
      const turn = await this.admit(inv, origin, sink, opts);
      if (!turn) return;
      if (opts.signal) turn.signal = opts.signal;
      warnings.push(...turn.grounds.warnings);
      // A named agent answers the request itself; Slack writes still need plan → approve.
      if (turn.agent) {
        const agent = turn.agent;
        const long = agent.kind !== 'assistant';
        if (!long) {
          await this.chat(inv, origin, sink, turn, warnings);
          return;
        }
        await runAsJob(this, origin, jobTitle(agent.title, origin), turn.signal, (signal) => {
          turn.signal = signal;
          return this.chat(inv, origin, sink, turn, warnings);
        });
        return;
      }
      const actionable = inv.inferredVerb && looksActionable(inv.instruction);
      if (!isActuating(inv.verb) && !actionable) {
        await this.chat(inv, origin, sink, turn, warnings);
        return;
      }
      let plan: CommandPlan | undefined;
      let verb = inv.verb;
      if (actionable) {
        const planned = await this.plan(inv, origin, sink, turn);
        if (!planned) return;
        if (!isActuating(planned.intent)) {
          await this.chat({ ...inv, verb: planned.intent }, origin, sink, turn, warnings);
          return;
        }
        plan = planned;
        verb = planned.intent;
      }
      await this.execute({ ...inv, verb }, origin, sink, turn, plan);
    } catch (err) {
      if (err instanceof IdentityRevokedError) {
        await this.promptConnect(inv, origin, sink, err.message, false);
        return;
      }
      console.error(`[ge-slack] turn failed: ${safeMessage(err)}`);
      await sink.notice(
        'error',
        'Something went wrong running that. Try again, or check `/gemini whoami`.',
      );
    }
  }

  // ------------------------------------------------------------------ admission

  private async admit(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    opts: RunOptions & { resume?: boolean } = {},
  ): Promise<Turn | undefined> {
    const { surface, config, identity } = this.deps;
    const scope = resolveScope(inv, origin);
    if ('error' in scope) {
      await sink.notice('error', scope.error);
      return undefined;
    }
    // Canvas scope: the file must be a canvas shared somewhere the invoker can see (H1).
    let canvasChannels: string[] = [];
    if (scope.kind === 'canvas') {
      const access = await surface.canvasAccess(scope.id);
      if (!access.isCanvas) {
        await sink.notice('error', 'That id is not a canvas.');
        return undefined;
      }
      const visible: string[] = [];
      for (const c of access.channels)
        if (await surface.isMember(c, origin.userId)) visible.push(c);
      if (!visible.length) {
        await sink.notice(
          'denied',
          "You don't have access to that canvas through any conversation you're in.",
        );
        return undefined;
      }
      canvasChannels = visible;
    }
    const channel = scopeChannel(scope) ?? canvasChannels[0] ?? origin.channelId;
    const info = channel ? await surface.conversationInfo(channel) : undefined;
    // Slack Connect coercion applies if *any* conversation this turn touches is shared externally.
    const touched = [
      ...new Set(
        [origin.channelId, scopeChannel(scope), inv.flags.to, ...canvasChannels].filter(
          (c): c is string => Boolean(c),
        ),
      ),
    ];
    let externallyShared = Boolean(origin.externallyShared);
    for (const c of touched) {
      if ((await surface.conversationInfo(c)).isExtShared) externallyShared = true;
    }
    const policy = await config.channelPolicy(origin.teamId, channel ?? '');

    if (scope.kind === 'search' && (opts.actionToken || opts.resume)) {
      // Workspace search reads public channels the person may not have joined, so its results
      // are private-only, read-only, never in shared channels, and never for guests/externals.
      const publicDelivery = origin.entry === 'mention' || inv.flags.visibility === 'public';
      if (externallyShared || publicDelivery || isActuating(inv.verb)) {
        await sink.notice(
          'denied',
          externallyShared
            ? "Workspace search isn't available in externally shared conversations."
            : isActuating(inv.verb)
              ? 'Workspace search is read-only. Ask or summarize with it, then draft from the conversation you want to change.'
              : 'Workspace search answers are private — ask in your Gemini DM (Messages tab).',
        );
        return undefined;
      }
      if (await surface.isGuest(origin.userId)) {
        await sink.notice('denied', "Guests and external members can't search the workspace.");
        return undefined;
      }
    }
    const agents = await config.agents(origin.teamId);
    const named = inv.grounds.flatMap((g) =>
      g.kind === 'alias'
        ? agents.filter((a) => a.alias.toLowerCase() === g.alias.toLowerCase())
        : [],
    );
    const agentBarsService = named.some((a) => !a.serviceAllowed);
    const resolved = await identity.resolve({
      teamId: origin.teamId,
      userId: origin.userId,
      policy: policy.identity,
      ...(inv.flags.as ? { requested: inv.flags.as } : {}),
      unattended: isUnattended(origin),
      externallyShared,
    });
    if (!resolved.ok) {
      const d = resolved.decision;
      if ((d.reason === 'needs-link' || d.reason === 'offline-required') && !isUnattended(origin)) {
        await this.promptConnect(
          inv,
          origin,
          sink,
          d.message,
          d.offerService && !agentBarsService,
          policy.serviceGrounds,
        );
      } else {
        await sink.notice('denied', d.message);
      }
      return undefined;
    }
    const principal = resolved.principal;

    // Membership gate: the human must be able to read everything in scope and every destination.
    // A resumed agent answer is delivered where the turn started: re-check that too.
    const mustBeMember = [
      scopeChannel(scope),
      inv.flags.to,
      ...(opts.resume && origin.entry !== 'agent-dm' ? [origin.channelId] : []),
    ].filter((c): c is string => Boolean(c));
    for (const c of new Set(mustBeMember)) {
      if (!(await surface.isMember(c, origin.userId))) {
        await sink.notice(
          'denied',
          `You're not a member of <#${c}>, so Gemini can't read or post there for you.`,
        );
        return undefined;
      }
    }
    if (principal.kind === 'service' && scope.kind === 'canvas') {
      // The canvas's own conversations decide, not the one the request came from (M7).
      let allowed = false;
      for (const c of canvasChannels) {
        if ((await config.channelPolicy(origin.teamId, c)).serviceMayRead) allowed = true;
      }
      if (!allowed) {
        await sink.notice(
          'denied',
          "The Gemini service isn't allowed to read that canvas. Connect your account to run this as you.",
        );
        return undefined;
      }
    }
    const readChannel = scopeChannel(scope) ?? canvasChannels[0];
    if (principal.kind === 'service' && readChannel && !policy.serviceMayRead) {
      await sink.notice(
        'denied',
        `The Gemini service isn't allowed to read <#${readChannel}>. Connect your account to run this as you.`,
      );
      return undefined;
    }

    // A person with no licence is told so (and offered the service where policy allows) before
    // anything is read on their behalf (EXPERIENCE §11).
    const serviceFallback =
      principal.kind === 'user' &&
      policy.identity !== 'user-only' &&
      identity.serviceConfigured &&
      !agentBarsService &&
      inv.flags.as !== 'me' &&
      !externallyShared;
    if (
      principal.kind === 'user' &&
      !opts.resume &&
      !(await licenceGate(this, inv, origin, sink, serviceFallback))
    ) {
      return undefined;
    }
    if (principal.kind === 'service' && !(await licenceServiceGuard(this, origin, sink))) {
      return undefined;
    }

    const [catalog, unit] = await Promise.all([
      config.catalog(origin.teamId),
      channel ? config.unit(origin.teamId, channel) : Promise.resolve(undefined),
    ]);
    const admission = admitAgent(
      {
        verb: inv.verb,
        grounds: inv.grounds,
        principal: principal.kind,
        unattended: isUnattended(origin),
        scope: scope.kind,
        scopeNamed: Boolean(inv.scope),
        externallyShared,
      },
      agents,
    );
    if (!admission.ok) {
      await sink.notice('denied', admission.message);
      return undefined;
    }
    const agent = admission.agent;
    const forwardContext = admission.forwardContext;
    // Agents ground only on sources named in the request (never the channel's @unit); A2A agents
    // bring their own tools, so data stores aren't sent to them at all.
    const grounds =
      agent && (agent.kind === 'a2a' || !admission.grounds.some((g) => g.kind === 'alias'))
        ? { dataStores: [], titles: [], warnings: [] }
        : resolveGrounds(
            { ...inv, grounds: admission.grounds },
            catalog,
            agent ? undefined : unit,
            principal,
            policy,
          );
    const badge: IdentityBadge = {
      kind: principal.kind,
      label: principalLabel(principal),
      ...(resolved.notice ? { notice: resolved.notice } : {}),
    };

    await sink.begin(this.title(inv, scope, info?.name));
    if (opts.resume) {
      // Continuing a paused agent: its session already holds the conversation; nothing is re-read.
      return {
        principal,
        readChannels: new Set(),
        externallyShared,
        tokens: resolved.tokens,
        identity: resolved.identity,
        badge,
        scope,
        grounds,
        ctx: undefined,
        allowedChannels: new Set(),
        forwardContext,
        memory: [],
        serviceFallback,
        ...(agent ? { agent } : {}),
      };
    }
    if (forwardContext) {
      await sink.task({
        id: 'capture',
        title: scope.kind === 'search' ? 'Searching Slack' : 'Reading the conversation',
        status: 'in_progress',
      });
    }
    let ctx: CapturedContext | undefined;
    if (!forwardContext) {
      await sink.task({
        id: 'capture',
        title: `Not sharing the conversation with ${agent?.title ?? 'the agent'} (name a scope to include it)`,
        status: 'complete',
      });
    } else if (scope.kind !== 'none') {
      ctx = await surface.capture(scope, {
        from: inv.from,
        maxMessages: this.deps.maxMessages ?? 200,
        ...(scope.kind === 'search' ? { search: scope.query } : {}),
        ...(scope.kind === 'search' && opts.actionToken ? { actionToken: opts.actionToken } : {}),
      });
      if (scope.kind === 'search' && principal.kind === 'service') {
        // The service may only read channels allow-listed for it, wherever search found them.
        const allowed = new Map<string, boolean>();
        const kept = [];
        for (const m of ctx.messages) {
          const c = m.channel ?? ctx.channel ?? '';
          if (!allowed.has(c))
            allowed.set(c, (await config.channelPolicy(origin.teamId, c)).serviceMayRead);
          if (allowed.get(c)) kept.push(m);
        }
        ctx = { ...ctx, messages: kept };
      }
      await sink.task({
        id: 'capture',
        title: `Read ${ctx.messages.length} message${ctx.messages.length === 1 ? '' : 's'}${ctx.truncated ? ' (most recent)' : ''}`,
        status: 'complete',
      });
    } else {
      await sink.task({ id: 'capture', title: 'No conversation in scope', status: 'complete' });
    }
    await sink.task({
      id: 'ground',
      title: grounds.titles.length
        ? `Grounded on ${grounds.titles.slice(0, 3).join(', ')}`
        : agent
          ? `Routed to ${agent.title}`
          : 'Grounded on the conversation only',
      status: 'complete',
    });

    const allowedChannels = new Set<string>(
      [origin.channelId, scopeChannel(scope), inv.flags.to].filter((c): c is string => Boolean(c)),
    );
    // Channel memory grounds turns that read a channel — never search hits, never an A2A agent
    // the invoker didn't point at the conversation (EXPERIENCE §10).
    // Never in unattended runs: nobody reviews what a note steers there (security review H1).
    const memory =
      forwardContext && !isUnattended(origin) && scope.kind !== 'none' && scope.kind !== 'search'
        ? await notesFor(this, origin.teamId, scopeChannel(scope))
        : [];
    if (memory.length) {
      await sink.task({
        id: 'memory',
        title: `Using ${memory.length} channel note${memory.length === 1 ? '' : 's'}`,
        status: 'complete',
      });
    }
    // Reads (executor `read <permalink>`) stay inside the admitted scope only (M3).
    const readChannels = new Set<string>(
      [scopeChannel(scope), ...canvasChannels].filter((c): c is string => Boolean(c)),
    );
    return {
      principal,
      readChannels,
      externallyShared,
      tokens: resolved.tokens,
      identity: resolved.identity,
      badge,
      scope,
      grounds,
      ctx,
      allowedChannels,
      forwardContext,
      memory,
      serviceFallback,
      ...(agent ? { agent } : {}),
    };
  }

  async promptConnect(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    message: string,
    offerService: boolean,
    serviceGrounds: string[] = [],
  ): Promise<void> {
    const resumeId = this.newId();
    await this.deps.stores.saveResume(resumeId, { origin, invocation: inv });
    const url = this.deps.linker
      ? await this.deps.linker.start({
          teamId: origin.teamId,
          slackUserId: origin.userId,
          resumeId,
        })
      : undefined;
    const catalog = offerService ? await this.deps.config.catalog(origin.teamId) : [];
    await sink.connect({
      message,
      ...(url ? { connectUrl: url } : {}),
      providerName: this.deps.linker?.providerName ?? 'your company SSO',
      offerService,
      serviceSources: catalog
        .filter((c) => c.serviceAllowed && serviceGrounds.includes(c.alias))
        .map((c) => c.title),
      resumeId,
    });
  }

  /** Resume a request after linking, or re-run it as the service ("Answer with the Gemini service"). */
  async resume(resumeId: string, userId: string, sink: TurnSink, asService = false): Promise<void> {
    const peek = await this.deps.stores.getResume(resumeId);
    if (!peek || peek.origin.userId !== userId) {
      await sink.notice('info', 'That request expired — run it again.');
      return;
    }
    const r = await this.deps.stores.takeResume(resumeId);
    if (!r) {
      await sink.notice('info', 'That request was already resumed.');
      return;
    }
    const inv = asService
      ? { ...r.invocation, flags: { ...r.invocation.flags, as: 'service' as const } }
      : r.invocation;
    await this.run(inv, r.origin, sink);
  }

  // ------------------------------------------------------------------ chat route

  private async chat(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
    warnings: string[],
    resume?: { handle: AgentHandle; text: string },
  ): Promise<boolean> {
    const agent = turn.agent;
    const who = agent
      ? `${agent.title} ${asWho(turn.principal)}`
      : `Gemini Enterprise ${asWho(turn.principal)}`;
    await sink.task({ id: 'ask', title: `Asking ${who}`, status: 'in_progress' });
    const text =
      resume?.text ??
      composeChatPrompt(inv, turn.forwardContext ? turn.ctx : undefined, turn.memory);
    // Deep Research needs its session for phase 2; A2A agents continue their context/task.
    const session = resume?.handle.session;
    const events = this.deps.gemini.stream(turn.tokens, {
      text,
      route: 'default',
      dataStores: turn.grounds.dataStores,
      ...(turn.grounds.notebookId ? { notebookId: turn.grounds.notebookId } : {}),
      ...(session ? { session } : {}),
      sessionless: agent?.kind !== 'deep-research',
      ...(agent
        ? {
            agent: {
              kind: agent.kind,
              agentId: agent.agentId,
              ...(resume?.handle.contextId ? { contextId: resume.handle.contextId } : {}),
              ...(resume?.handle.taskId ? { taskId: resume.handle.taskId } : {}),
            },
          }
        : {}),
      identity: turn.identity,
      ...(turn.signal ? { signal: turn.signal } : {}),
    });
    const sources: SourceRef[] = [];
    let related: string[] = [];
    let provenance;
    let complete = false;
    let unauthorized: string[] = [];
    let files = 0;
    let awaiting: Extract<AssistEvent, { type: 'awaiting' }> | undefined;
    // Model output is sanitized on every path, including the live stream (M2).
    const sanitizer = new StreamSanitizer(this.knownUsers(turn.ctx, inv, origin));
    // Workflow steps return their answer as step outputs (the workflow decides where it lands);
    // every other unattended answer is a write and goes through the gate.
    const unattended = isUnattended(origin) && origin.entry !== 'workflow';
    for await (const e of events) {
      if (e.type === 'token') {
        const safe = sanitizer.push(e.text);
        if (safe && !unattended) await sink.token(safe);
      } else if (e.type === 'citation') sources.push(e.source);
      else if (e.type === 'related-questions') related = e.questions;
      else if (e.type === 'provenance') provenance = e.payload;
      else if (e.type === 'connector-auth') unauthorized = e.connectors;
      else if (e.type === 'file') files++;
      else if (e.type === 'awaiting') awaiting = e;
      else if (e.type === 'policy') {
        await sink.task({ id: 'ask', title: 'Blocked by policy', status: 'error' });
        await sink.notice('policy', e.reason);
        return false;
      } else if (e.type === 'error') {
        await sink.task({
          id: 'ask',
          title: 'Gemini Enterprise returned an error',
          status: 'error',
        });
        await this.providerError(inv, origin, sink, turn, e.code);
        return false;
      } else if (e.type === 'done') complete = true;
    }
    if (!complete) {
      if (turn.signal?.aborted) {
        await sink.task({ id: 'ask', title: 'Stopped', status: 'error' });
        await sink.notice('info', 'Stopped. Nothing was posted.');
        return false;
      }
      await sink.notice('error', 'The answer was cut off before it finished. Try again.');
      return false;
    }
    const tail = sanitizer.finish();
    if (tail && !unattended) await sink.token(tail);
    const answerText = sanitizer.text;
    await sink.task({
      id: 'ask',
      title: awaiting
        ? `${agent?.title ?? 'The agent'} is waiting for you`
        : `Answered ${asWho(turn.principal)}`,
      status: 'complete',
    });
    if (unauthorized.length) {
      warnings.unshift(this.connectorAuthWarning(unauthorized, turn.principal));
    }
    if (files) {
      warnings.push(
        `${agent?.title ?? 'Gemini Enterprise'} also made ${files === 1 ? 'a file' : `${files} files`} (e.g. an audio summary) — open it in Gemini Enterprise.`,
      );
    }
    if (agent?.kind === 'a2a') {
      warnings.push(
        `${agent.title} is a custom agent: its answer isn't screened by Gemini Enterprise Model Armor.`,
      );
    }
    if (unattended) {
      // Unattended answers are writes like any other: gate, provenance, ledger, undo (H4).
      await this.landUnattendedAnswer(
        answerText,
        sources,
        provenance?.agentId,
        inv,
        origin,
        sink,
        turn,
      );
      return true;
    }
    const turnId = this.newId();
    const stored: StoredAnswer = {
      turnId,
      teamId: origin.teamId,
      invokerId: origin.userId,
      origin,
      text: answerText,
      ...(provenance ? { provenance } : {}),
      principal: turn.identity,
      shareable: turn.scope.kind !== 'search',
    };
    await this.deps.stores.saveAnswer(stored);
    await sink.answer({
      turnId,
      text: answerText,
      sources,
      identity: turn.badge,
      grounded: sources.length > 0,
      related,
      warnings,
      shareable:
        turn.scope.kind !== 'search' &&
        Boolean(origin.channelId) &&
        (origin.entry === 'slash' ||
          origin.entry === 'message-shortcut' ||
          origin.entry === 'modal' ||
          origin.entry === 'global-shortcut'),
      followUps: Boolean(origin.channelId),
      provenance: {
        changeId: `ans_${turnId}`,
        agentId: provenance?.agentId ?? 'gemini-enterprise',
        principal: turn.identity,
        invoker: origin.userId,
        approval: 'human',
        edited: false,
        timestamp: this.now().toISOString(),
        contentHash: await contentHash(answerText),
        sources: sources
          .slice(0, 20)
          .map((s) => ({ title: s.title, ...(s.uri ? { uri: s.uri } : {}) })),
      },
      ...(agent ? { via: agent.kind === 'a2a' ? `${agent.title} · A2A` : agent.title } : {}),
      ...(unauthorized.length && turn.principal.kind === 'user' && this.deps.appUrl
        ? { authorizeUrl: this.deps.appUrl }
        : {}),
      ...(turn.memory.length && !resume ? { memoryNotes: turn.memory.length } : {}),
    });
    if (awaiting && agent) await this.pauseAgent(awaiting, agent, inv, origin, sink, turn);
    return true;
  }

  /**
   * A provider error, shown without its body (L2). A 403 on a user turn is usually a missing
   * licence: check, and show the licence card instead of a bare code when it is (EXPERIENCE §11).
   */
  private async providerError(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
    code: string,
  ): Promise<void> {
    if (
      code === 'http_403' &&
      turn.principal.kind === 'user' &&
      (await licenceOnForbidden(this, inv, origin, sink, turn.serviceFallback))
    ) {
      return;
    }
    await sink.notice('error', friendlyProviderError(code));
  }

  private connectorAuthWarning(names: string[], principal: Principal): string {
    const list = names.slice(0, 5).map(displayName).join(', ');
    if (principal.kind === 'service') {
      return `Skipped sources the Gemini service isn't authorized for: ${list}. Ask an admin.`;
    }
    return `Skipped sources you haven't authorized yet: ${list}. Authorize them in Gemini Enterprise (Manage your data), then ask again.`;
  }

  /** Save a paused agent turn and show the invoker how to continue it (ADR-0002). */
  private async pauseAgent(
    e: Extract<AssistEvent, { type: 'awaiting' }>,
    agent: AgentEntry,
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
  ): Promise<void> {
    // Slack capabilities (response_url, trigger_id) are short-lived and never stored with it.
    const { responseUrl: _r, triggerId: _t, ...storedOrigin } = origin;
    const c: AgentContinuation = {
      id: this.newId(),
      teamId: origin.teamId,
      invokerId: origin.userId,
      origin: storedOrigin,
      invocation: inv,
      agentAlias: agent.alias,
      agentId: agent.agentId,
      reason: e.reason,
      handle: e.handle,
      identity: turn.identity,
      expiresAt: this.now().getTime() + AGENT_CONTINUATION_TTL_MS,
    };
    await this.deps.stores.saveContinuation(c, this.now().getTime());
    await sink.awaiting({
      continuationId: c.id,
      reason: e.reason,
      agentTitle: agent.title,
      invokerId: origin.userId,
      ...(this.deps.appUrl ? { authorizeUrl: this.deps.appUrl } : {}),
    });
  }

  /**
   * Continue a paused agent: start a Deep Research plan (optionally refined), answer an A2A
   * agent's question, or retry after authorizing. Invoker only, once, same principal, and the
   * membership gate is re-checked like an approval.
   */
  async continueAgent(
    id: string,
    userId: string,
    reply: string | undefined,
    sink: TurnSink,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const peek = await this.deps.stores.getContinuation(id);
    if (!peek || peek.expiresAt < this.now().getTime()) {
      await sink.notice('info', 'That agent conversation expired — ask again.');
      return;
    }
    if (peek.invokerId !== userId) {
      await sink.notice('denied', `Only <@${peek.invokerId}> can continue this.`);
      return;
    }
    const text = reply?.trim().slice(0, 4000);
    if (peek.reason === 'input-required' && !text) {
      await sink.notice('clarify', 'Type an answer for the agent first.');
      return;
    }
    const c = await this.deps.stores.takeContinuation(id);
    if (!c) {
      await sink.notice('info', 'That was already continued.');
      return;
    }
    try {
      const turn = await this.admit(c.invocation, c.origin, sink, { resume: true });
      if (!turn) return;
      if (opts.signal) turn.signal = opts.signal;
      if (turn.identity !== c.identity) {
        await sink.notice(
          'denied',
          'This agent conversation was started under a different identity. Ask again to start a new one.',
        );
        return;
      }
      if (!turn.agent || turn.agent.agentId !== c.agentId) {
        await sink.notice('info', `@${c.agentAlias} is no longer available here.`);
        return;
      }
      const next =
        c.reason === 'research-plan'
          ? text
            ? `Revise the research plan: ${text}`
            : 'Start Research'
          : c.reason === 'input-required'
            ? text!
            : // Never replay the original request into the task: it could repeat side effects.
              "I've completed the authorization. Please continue the task.";
      await runAsJob(
        this,
        c.origin,
        jobTitle(turn.agent.title, c.origin),
        turn.signal,
        (signal) => {
          turn.signal = signal;
          return this.chat(c.invocation, c.origin, sink, turn, [], {
            handle: c.handle,
            text: next,
          });
        },
      );
    } catch (err) {
      if (err instanceof IdentityRevokedError) {
        await sink.notice('denied', err.message);
        return;
      }
      console.error(`[ge-slack] agent continuation failed: ${safeMessage(err)}`);
      await sink.notice('error', 'Something went wrong continuing that. Ask again.');
    }
  }

  private knownUsers(
    ctx: CapturedContext | undefined,
    inv: Invocation,
    origin: Origin,
  ): Set<string> {
    // Authors of workspace-search hits are not people of this conversation (no pings/DMs).
    const fromCtx = inv.scope?.kind === 'search' ? [] : (ctx?.messages ?? []);
    return new Set<string>([
      ...fromCtx.flatMap((m) => (m.user ? [m.user] : [])),
      ...inv.people,
      ...inv.from,
      origin.userId,
    ]);
  }

  /**
   * The unattended gate, evaluated per target: the *destination's* policy must allow auto-apply,
   * the destination must not be externally shared, and the effect must be a reply in the
   * triggering thread or a post to the configured destination (M10).
   */
  private async autoApplicable(
    p: ActuationParams,
    inv: Invocation,
    origin: Origin,
  ): Promise<boolean> {
    const targets = targetChannels(p);
    if (targets.length !== 1) return false;
    const target = targets[0]!;
    const [policy, info] = await Promise.all([
      this.deps.config.channelPolicy(origin.teamId, target),
      this.deps.surface.conversationInfo(target),
    ]);
    if (info.isExtShared) return false;
    return canAutoApply(p, {
      ...(origin.channelId ? { originChannel: origin.channelId } : {}),
      ...(origin.threadTs ? { originThreadTs: origin.threadTs } : {}),
      ...(inv.flags.to ? { destination: inv.flags.to } : {}),
      channelAutoApply: policy.autoApply,
    });
  }

  private async landUnattendedAnswer(
    text: string,
    sources: SourceRef[],
    agentId: string | undefined,
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
  ): Promise<void> {
    const body = (text.length > 3900 ? `${text.slice(0, 3899)}…` : text) || '(no answer)';
    const destination = inv.flags.to ?? origin.channelId;
    if (!destination) {
      await sink.notice('error', 'This automation has no destination.');
      return;
    }
    const params: ActuationParams =
      origin.threadTs && origin.channelId && !inv.flags.to
        ? { kind: 'reply', channel: origin.channelId, threadTs: origin.threadTs, text: body }
        : { kind: 'post', channel: destination, text: body };
    const createdAt = this.now().getTime();
    const pending: PendingPlan = {
      id: this.newId(),
      teamId: origin.teamId,
      invokerId: origin.userId,
      ...(turn.memory.length ? { memoryNotes: turn.memory.length } : {}),
      origin,
      invocation: inv,
      scope: turn.scope,
      effects: [
        {
          changeId: `chg_${randomUUID()}`,
          params,
          line: params.kind === 'reply' ? 'reply "…"' : `post <#${destination}> "…"`,
          label: params.kind === 'reply' ? 'Reply in thread' : `Post message in <#${destination}>`,
          preview: body.replace(/\s+/g, ' ').slice(0, 140),
          approvalClass: 'in-conversation',
          reversible: true,
        },
      ],
      sources,
      agentId: agentId ?? 'gemini-enterprise',
      contentHash: await contentHash(body),
      identity: turn.identity,
      ...(origin.automationId ? { automationId: origin.automationId } : {}),
      dryRun: false,
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
    };
    if (await this.autoApplicable(params, inv, origin)) {
      await this.apply(pending, turn.identity, turn.badge, sink, { approval: 'auto' });
      return;
    }
    await this.deps.stores.savePlan(pending);
    await sink.plan(this.planView(pending, turn.badge));
  }

  // ------------------------------------------------------------------ planner route

  private async plan(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
  ): Promise<CommandPlan | undefined> {
    await sink.task({ id: 'plan', title: 'Planning', status: 'in_progress' });
    const r = await collectStream(
      this.deps.gemini.stream(turn.tokens, {
        text: composePlannerPrompt(inv, turn.ctx, turn.memory),
        route: 'planner',
        sessionless: true,
        identity: turn.identity,
        ...(turn.signal ? { signal: turn.signal } : {}),
      }),
    );
    if (r.blocked) {
      await sink.notice('policy', "Gemini Enterprise's policy blocked this response.");
      return undefined;
    }
    if (r.error || !r.complete) {
      await this.providerError(inv, origin, sink, turn, r.error?.code ?? 'incomplete');
      return undefined;
    }
    const p = parsePlanBlock(r.text);
    if (!p.ok) {
      // A planner that didn't produce a plan means "just answer": fall back to chat semantics.
      await sink.task({ id: 'plan', title: 'Answering directly', status: 'complete' });
      return { intent: 'ask', surface: 'slack', ground: [], steps: [], excludes: [], clarify: [] };
    }
    if (p.needsClarification) {
      await sink.task({ id: 'plan', title: 'Needs a detail from you', status: 'complete' });
      await sink.notice('clarify', p.plan.clarify.map((q) => `• ${q}`).join('\n'));
      return undefined;
    }
    await sink.task({
      id: 'plan',
      title: `Planned: ${p.plan.intent} · ${p.plan.steps.length} steps`,
      status: 'complete',
    });
    return p.plan;
  }

  // ------------------------------------------------------------------ executor route

  /**
   * Connector tools this turn may propose with `act` (EXPERIENCE §10): the ones the connector
   * offers *this principal* (tools/list as them) that an admin allow-listed — and, for the service,
   * marked serviceAllowed. Discovery failures drop that connector; they never fail the turn.
   */
  private async connectorTools(
    origin: Origin,
    turn: Turn,
    sink: TurnSink,
  ): Promise<AvailableConnectorTool[]> {
    const port = this.deps.connectors;
    if (!port || !this.deps.features?.has('connector-actions') || turn.agent) return [];
    // Never proposed from content nobody is present to own (unattended), from a conversation
    // shared with another organization, or for guests/externals (F3, F4).
    if (isUnattended(origin) || turn.externallyShared) return [];
    if (await this.deps.surface.isGuest(origin.userId)) return [];
    const catalog = await this.deps.config.connectors(origin.teamId);
    const out: AvailableConnectorTool[] = [];
    for (const c of catalog) {
      const allowed = c.tools.filter((t) => turn.principal.kind === 'user' || t.serviceAllowed);
      if (!allowed.length) continue;
      const key = `${turn.identity}|${c.collection}`;
      let listed = this.toolCache.get(key);
      if (!listed || listed.until < Date.now()) {
        try {
          listed = {
            tools: await port.listTools(turn.tokens, c.collection),
            until: Date.now() + 600_000,
          };
          if (this.toolCache.size > 500) this.toolCache.clear();
          this.toolCache.set(key, listed);
        } catch {
          continue;
        }
      }
      for (const t of allowed) {
        const offered = listed.tools.find((x) => x.name === t.name);
        if (!offered) continue;
        const schema = offered.inputSchema ? JSON.stringify(offered.inputSchema) : undefined;
        out.push({
          alias: c.alias,
          title: c.title,
          collection: c.collection,
          name: t.name,
          ...((t.description ?? offered.description)
            ? { description: (t.description ?? offered.description)!.slice(0, 300) }
            : {}),
          ...(schema ? { inputSchema: schema.slice(0, 1500) } : {}),
        });
      }
    }
    if (out.length) {
      await sink.task({
        id: 'connectors',
        title: `Connector tools available: ${[...new Set(out.map((t) => t.title))].join(', ')}`,
        status: 'complete',
      });
    }
    return out;
  }

  private async execute(
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
    turn: Turn,
    plan?: CommandPlan,
  ): Promise<void> {
    const connectorTools =
      inv.verb === 'draft' || inv.verb === 'notes'
        ? await this.connectorTools(origin, turn, sink)
        : [];
    const kinds: ActuationKind[] = [
      ...kindsFor(inv.verb, turn.scope),
      ...(connectorTools.length && turn.scope.kind !== 'search'
        ? (['connector-action'] as const)
        : []),
    ];
    const maxTurns = this.deps.maxExecutorTurns ?? 3;
    const maxEffects = this.deps.maxEffects ?? 8;
    let feedback: string | undefined;
    let compiled: CompiledEffect[] = [];
    let sources: SourceRef[] = [];
    let agentId = 'gemini-enterprise';
    const ctx: CapturedContext = turn.ctx ?? {
      label: 'no conversation',
      messages: [],
      truncated: false,
    };

    await sink.task({
      id: 'ask',
      title: `Drafting changes ${asWho(turn.principal)}`,
      status: 'in_progress',
    });
    for (let i = 0; i < maxTurns; i++) {
      if (turn.signal?.aborted) {
        await sink.notice('info', 'Stopped. Nothing was proposed or changed.');
        return;
      }
      const r = await collectStream(
        this.deps.gemini.stream(turn.tokens, {
          text: composeCommandPrompt({
            inv,
            ctx,
            kinds,
            ...(plan ? { plan } : {}),
            ...(feedback ? { feedback } : {}),
            now: this.now(),
            timeZone: this.deps.timeZone ?? 'UTC',
            memory: turn.memory,
            connectorTools,
            targets: [...turn.allowedChannels].map((id) => ({
              id,
              label: id === origin.channelId ? 'here' : 'named',
            })),
          }),
          route: 'command',
          dataStores: turn.grounds.dataStores,
          ...(turn.grounds.notebookId ? { notebookId: turn.grounds.notebookId } : {}),
          sessionless: true,
          identity: turn.identity,
          ...(turn.signal ? { signal: turn.signal } : {}),
        }),
      );
      if (r.blocked) {
        await sink.notice('policy', "Gemini Enterprise's policy blocked this response.");
        return;
      }
      if (turn.signal?.aborted) {
        await sink.notice('info', 'Stopped. Nothing was proposed or changed.');
        return;
      }
      if (r.error || !r.complete) {
        // Provider EOF is not completion: never execute a fence from an incomplete stream.
        await this.providerError(inv, origin, sink, turn, r.error?.code ?? 'incomplete');
        return;
      }
      sources = mergeSources(sources, r.sources);
      if (r.provenance) agentId = r.provenance.agentId;

      const program = parseProgram(r.text);
      if ('fenceError' in program) {
        feedback = `error: respond with exactly one closed \`\`\`cmd fence (${program.fenceError.ok ? '' : program.fenceError.reason})`;
        continue;
      }
      const readResults: string[] = [];
      for (const line of program.lines) {
        if (line.verb === 'read' || line.verb === 'search') {
          readResults.push(await this.serveRead(line, ctx, turn));
        }
      }
      const knownUsers = this.knownUsers(ctx, inv, origin);
      const knownMessages = new Set<string>([
        ...ctx.messages.map((m) => `${m.channel ?? ctx.channel ?? ''}:${m.ts}`),
        ...(turn.scope.kind === 'thread' || turn.scope.kind === 'message'
          ? [`${turn.scope.channel}:${turn.scope.ts}`]
          : []),
      ]);
      const errors = [...program.errors];
      const effects: CompiledEffect[] = [];
      const compileCtx = {
        scope: turn.scope,
        ...(origin.channelId ? { originChannel: origin.channelId } : {}),
        allowedChannels: turn.allowedChannels,
        knownUsers,
        knownMessages,
        now: this.now(),
        connectorTools,
      };
      const actionItems: Array<{
        effect: Extract<CmdEffect, { kind: 'action-item' }>;
        line: string;
      }> = [];
      for (const line of program.lines) {
        if (line.verb !== 'effect') continue;
        if (!kinds.includes(effectKind(line.effect))) {
          errors.push(
            `${line.line}: ${effectKind(line.effect)} is not available for /${inv.verb} here`,
          );
          continue;
        }
        if (line.effect.kind === 'action-item') {
          actionItems.push({ effect: line.effect, line: line.line });
          continue;
        }
        const c = compileEffect(line.effect, line.line, compileCtx);
        if (c.ok) effects.push(c.effect);
        else errors.push(c.error);
      }
      if (actionItems.length) {
        const c = compileActionItems(actionItems, compileCtx, `Action items — ${ctx.label}`);
        if (c.ok) effects.push(c.effect);
        else errors.push(c.error);
      }
      if (effects.length > maxEffects)
        errors.push(`too many effects (${effects.length} > ${maxEffects}); combine them`);
      if (errors.length) {
        feedback = errors.map((e) => `error: ${e}`).join('\n');
        compiled = [];
        continue;
      }
      if (readResults.length && effects.length === 0 && !program.done) {
        feedback = readResults.join('\n');
        continue;
      }
      compiled = effects;
      feedback = undefined;
      break;
    }

    if (feedback) {
      await sink.task({ id: 'ask', title: "Couldn't produce a valid plan", status: 'error' });
      await sink.notice(
        'error',
        `Gemini couldn't produce changes Slack can apply:\n${feedback.slice(0, 1500)}`,
      );
      return;
    }
    if (compiled.length === 0) {
      await sink.task({ id: 'ask', title: 'Nothing to change', status: 'complete' });
      await sink.notice(
        'info',
        inv.verb === 'review'
          ? 'Review complete — no findings.'
          : 'Gemini found nothing to change.',
      );
      return;
    }
    await sink.task({
      id: 'ask',
      title: `Proposed ${compiled.length} change${compiled.length === 1 ? '' : 's'}`,
      status: 'complete',
    });

    const createdAt = this.now().getTime();
    const pending: PendingPlan = {
      id: this.newId(),
      teamId: origin.teamId,
      invokerId: origin.userId,
      ...(turn.memory.length ? { memoryNotes: turn.memory.length } : {}),
      origin,
      invocation: inv,
      scope: turn.scope,
      effects: compiled,
      sources,
      agentId,
      contentHash: await contentHash(compiled.map((e) => JSON.stringify(e.params)).join('\n')),
      identity: turn.identity,
      ...(origin.automationId ? { automationId: origin.automationId } : {}),
      dryRun: inv.flags.dryRun === true,
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
    };

    // Unattended gate (fail closed): auto-apply only when *every* effect is allowed.
    if (isUnattended(origin) && !pending.dryRun) {
      let auto = true;
      for (const e of compiled)
        if (!(await this.autoApplicable(e.params, inv, origin))) auto = false;
      if (auto) {
        await this.apply(pending, turn.identity, turn.badge, sink, { approval: 'auto' });
        return;
      }
    }
    await this.deps.stores.savePlan(pending);
    await sink.plan(this.planView(pending, turn.badge, plan));
  }

  private async serveRead(
    line: Extract<CmdLine, { verb: 'read' | 'search' }>,
    ctx: CapturedContext,
    turn: Turn,
  ): Promise<string> {
    if (line.verb === 'search') {
      const q = line.query.toLowerCase();
      const hits = ctx.messages.filter((m) => m.text.toLowerCase().includes(q));
      return `search "${line.query}": ${hits.length} match(es): ${hits
        .slice(0, 20)
        .map((m) => m.permalink ?? m.ts)
        .join(', ')}`;
    }
    let scope: ResolvedScope | undefined;
    if (
      line.target === 'thread' &&
      (turn.scope.kind === 'thread' || turn.scope.kind === 'message')
    ) {
      scope = { kind: 'thread', channel: turn.scope.channel, ts: turn.scope.ts };
    } else if (line.target === 'channel' && ctx.channel) {
      scope = { kind: 'channel', channel: ctx.channel, sinceMs: 7 * 86_400_000 };
    } else if (typeof line.target === 'object') {
      // A permalink read is only served within conversations already admitted for this turn.
      if (!turn.readChannels.has(line.target.channel)) return `${line.line}: not in scope`;
      scope = { kind: 'thread', channel: line.target.channel, ts: line.target.ts };
    }
    if (!scope) return `${line.line}: nothing to read`;
    const more = await this.deps.surface.capture(scope, { from: [], maxMessages: 100 });
    const seen = new Set(ctx.messages.map((m) => m.ts));
    const fresh = more.messages
      .filter((m) => !seen.has(m.ts))
      .map((m) => ({
        ...m,
        channel: m.channel ?? more.channel ?? ('channel' in scope ? scope.channel : undefined),
      }));
    ctx.messages.push(...fresh);
    return `${line.line}: read ${fresh.length} new message(s); they are now in <slack_context>`;
  }

  private planView(p: PendingPlan, badge: IdentityBadge, plan?: CommandPlan): PlanView {
    return {
      planId: p.id,
      title: p.dryRun
        ? 'Dry run — nothing will be applied'
        : `Gemini wants to make ${p.effects.length} change${p.effects.length === 1 ? '' : 's'}`,
      grammar: renderInvocation(p.invocation),
      verb: p.invocation.verb,
      effects: p.effects.map((e, index) => ({
        index: index + 1,
        changeId: e.changeId,
        skipped: (p.skipped ?? []).includes(e.changeId),
        kind: e.params.kind,
        label: e.label,
        preview: e.preview,
        approvalClass: e.approvalClass,
        reversible: e.reversible,
        line: e.line,
        ...(e.detail ? { detail: e.detail } : {}),
      })),
      identity: badge,
      invokerId: p.invokerId,
      steps: plan?.steps ?? [],
      dryRun: p.dryRun,
      expiresAt: new Date(p.expiresAt).toISOString(),
      sources: p.sources,
      ...(p.memoryNotes ? { memoryNotes: p.memoryNotes } : {}),
    };
  }

  // ------------------------------------------------------------------ approval + actuation

  /** Approve a plan. Only its invoker may; it is consumed exactly once and re-admitted now. */
  async approve(
    planId: string,
    userId: string,
    sink: TurnSink,
    edits: Record<string, string> = {},
  ): Promise<void> {
    const peek = await this.deps.stores.getPlan(planId);
    // Approval clicks aren't new requests: record only what lands.
    if (peek) {
      sink = observingSink(this, peek.teamId, { verb: peek.invocation.verb }, sink, {
        turns: false,
      });
    }
    if (!peek) {
      await sink.notice('info', 'This plan expired or was already handled — run it again.');
      return;
    }
    if (peek.invokerId !== userId) {
      await sink.notice('denied', `Only <@${peek.invokerId}> can approve this plan.`);
      return;
    }
    const p = await this.deps.stores.takePlan(planId);
    if (!p) {
      await sink.notice('info', 'This plan was already handled.');
      return;
    }
    if (p.expiresAt < this.now().getTime()) {
      await sink.notice('info', 'This plan expired — run it again.');
      return;
    }
    if (p.dryRun) {
      await sink.retire('Dry run closed — nothing was applied.');
      return;
    }
    // The edit dialog can't show connector arguments, so it can't approve them (F5).
    if (Object.keys(edits).length && p.effects.some((e) => e.params.kind === 'connector-action')) {
      await sink.notice(
        'denied',
        'Plans with connector actions can’t be approved from the edit dialog. Run it again and approve the card.',
      );
      return;
    }
    // Re-admit at click time: identity and membership may have changed since the card rendered.
    const channel = scopeChannel(p.scope) ?? p.origin.channelId ?? '';
    const policy = await this.deps.config.channelPolicy(p.teamId, channel);
    const targets = new Set(p.effects.flatMap((e) => targetChannels(e.params)));
    let externallyShared = Boolean(p.origin.externallyShared);
    for (const c of new Set([channel, ...targets].filter(Boolean))) {
      if ((await this.deps.surface.conversationInfo(c)).isExtShared) externallyShared = true;
    }
    const resolved = await this.deps.identity.resolve({
      teamId: p.teamId,
      userId,
      policy: policy.identity,
      ...(p.invocation.flags.as ? { requested: p.invocation.flags.as } : {}),
      unattended: false,
      externallyShared,
    });
    if (!resolved.ok) {
      await sink.notice('denied', resolved.decision.message);
      return;
    }
    // The content was drafted by one principal; never land it under a different one (M5).
    if (resolved.identity !== p.identity) {
      await sink.notice(
        'denied',
        'The identity this plan was drafted with no longer applies here (you connected, disconnected, or the channel policy changed). Run it again.',
      );
      return;
    }
    // The scope the content was read from must still be readable by the approver.
    for (const c of new Set([
      ...targets,
      ...(scopeChannel(p.scope) ? [scopeChannel(p.scope)!] : []),
    ])) {
      if (!(await this.deps.surface.isMember(c, userId))) {
        await sink.notice('denied', `You're no longer a member of <#${c}>; nothing was applied.`);
        return;
      }
    }
    // Canvas edits: re-check that the approver can still reach the canvas (H1).
    for (const e of p.effects) {
      if (e.params.kind !== 'canvas-edit') continue;
      const access = await this.deps.surface.canvasAccess(e.params.canvasId);
      let ok = access.isCanvas;
      if (ok) {
        ok = false;
        for (const c of access.channels) if (await this.deps.surface.isMember(c, userId)) ok = true;
      }
      if (!ok) {
        await sink.notice(
          'denied',
          'You no longer have access to that canvas; nothing was applied.',
        );
        return;
      }
    }
    const knownUsers = new Set<string>([
      ...p.invocation.people,
      userId,
      ...p.effects.flatMap((e) => mentionedUsers(e.params)),
    ]);
    for (const e of p.effects) {
      const edited = edits[e.changeId];
      if (edited === undefined) continue;
      const next = withText(e.params, sanitizeOutbound(edited, knownUsers));
      // Only text effects are editable; mark `edited` only when something actually changed (F5).
      if (JSON.stringify(next) !== JSON.stringify(e.params)) {
        e.params = next;
        (e as CompiledEffect & { edited?: boolean }).edited = true;
      }
    }
    const badge: IdentityBadge = {
      kind: resolved.principal.kind,
      label: principalLabel(resolved.principal),
    };
    const skipped = new Set(p.skipped ?? []);
    if (skipped.size >= p.effects.length) {
      await sink.notice('info', 'Every change was skipped — nothing was applied.');
      return;
    }
    // Connector actions: the admin allow-list (and the feature) must still permit each one now.
    const actions = p.effects.filter(
      (e) => e.params.kind === 'connector-action' && !skipped.has(e.changeId),
    );
    if (actions.length) {
      const catalog = this.deps.features?.has('connector-actions')
        ? await this.deps.config.connectors(p.teamId)
        : [];
      for (const e of actions) {
        const a = e.params as Extract<ActuationParams, { kind: 'connector-action' }>;
        const entry = catalog.find((c) => c.alias === a.connector && c.collection === a.collection);
        const tool = entry?.tools.find((t) => t.name === a.tool);
        if (!tool || (resolved.principal.kind === 'service' && !tool.serviceAllowed)) {
          await sink.notice(
            'denied',
            `${a.connector}.${a.tool} is no longer allowed here; nothing was applied.`,
          );
          return;
        }
      }
    }
    await sink.executing(this.planView(p, badge));
    await this.apply(
      p,
      resolved.identity,
      badge,
      sink,
      { approval: 'human', approvedBy: userId },
      resolved.tokens,
    );
  }

  /** Tick/untick one change on a pending plan (review findings). Invoker only; re-renders the card. */
  async toggleEffect(
    planId: string,
    changeId: string,
    userId: string,
    sink: TurnSink,
  ): Promise<void> {
    const peek = await this.deps.stores.getPlan(planId);
    if (!peek || peek.expiresAt < this.now().getTime()) {
      await sink.notice('info', 'This plan expired or was already handled.');
      return;
    }
    if (peek.invokerId !== userId) {
      await sink.notice('denied', `Only <@${peek.invokerId}> can change this plan.`);
      return;
    }
    // Take (atomic) → modify → save, so a concurrent Approve can never see a plan that a toggle
    // later resurrects; whichever takes it first wins (M3).
    const p = await this.deps.stores.takePlan(planId);
    if (!p) {
      await sink.notice('info', 'This plan was already handled.');
      return;
    }
    const skipped = new Set(p.skipped ?? []);
    if (p.effects.some((e) => e.changeId === changeId)) {
      if (skipped.has(changeId)) skipped.delete(changeId);
      else skipped.add(changeId);
    }
    const next = { ...p, skipped: [...skipped] };
    await this.deps.stores.savePlan(next, this.now().getTime());
    const kind = p.identity.startsWith('service:') ? 'service' : 'user';
    await sink.plan(
      this.planView(next, { kind, label: p.identity.replace(/^(user|service):/, '') }),
    );
  }

  async cancel(planId: string, userId: string, sink: TurnSink): Promise<void> {
    const peek = await this.deps.stores.getPlan(planId);
    if (peek && peek.invokerId !== userId) {
      await sink.notice('denied', `Only <@${peek.invokerId}> can cancel this plan.`);
      return;
    }
    const taken = await this.deps.stores.takePlan(planId);
    if (taken) await sink.retire('Cancelled — nothing was changed.');
    else await sink.notice('info', 'This plan was already handled.');
  }

  private async apply(
    p: PendingPlan,
    identity: string,
    badge: IdentityBadge,
    sink: TurnSink,
    approval: { approval: 'human' | 'auto'; approvedBy?: string },
    tokens?: TokenSource,
  ): Promise<void> {
    const results: LandedView['results'] = [];
    const skipped = new Set(p.skipped ?? []);
    const sources = p.sources
      .slice(0, 20)
      .map((s) => ({ title: s.title, ...(s.uri ? { uri: s.uri } : {}) }));
    for (const e of p.effects) {
      if (skipped.has(e.changeId)) continue;
      const provenance: WriteProvenance = {
        changeId: e.changeId,
        agentId: p.agentId,
        principal: identity,
        invoker: p.invokerId,
        ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}),
        approval: approval.approval,
        edited: (e as CompiledEffect & { edited?: boolean }).edited === true,
        timestamp: this.now().toISOString(),
        contentHash: await contentHash(JSON.stringify(e.params)),
        sources,
        ...(p.automationId ? { automationId: p.automationId } : {}),
      };
      const req: ActuationRequest = { changeId: e.changeId, params: e.params, provenance };
      const external =
        e.params.kind === 'connector-action'
          ? {
              connector: e.params.connector,
              collection: e.params.collection,
              tool: e.params.tool,
              argsHash: await contentHash(JSON.stringify(e.params.arguments)),
            }
          : undefined;
      if (external) {
        // Ledger first: if this instance dies mid-call, the action still leaves a trace (F7).
        await this.deps.stores.record({
          changeId: e.changeId,
          teamId: p.teamId,
          invokerId: p.invokerId,
          ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}),
          approval: approval.approval,
          kind: e.params.kind,
          label: e.label,
          outcome: 'uncertain',
          principal: identity,
          external,
          at: this.now().toISOString(),
        });
      }
      let res;
      try {
        res =
          e.params.kind === 'connector-action'
            ? await this.runConnectorAction(e.changeId, e.params, tokens, approval.approval)
            : await this.deps.surface.actuate(req);
      } catch (err) {
        // Thrown after dispatch: the write may or may not have landed. Never report success.
        res = {
          changeId: e.changeId,
          kind: e.params.kind,
          outcome: 'uncertain' as const,
          provenancePersisted: false,
          error: { code: 'outcome_unknown', message: safeMessage(err) },
        };
      }
      if (res.changeId !== e.changeId || res.kind !== e.params.kind) {
        res = { ...res, changeId: e.changeId, kind: e.params.kind, outcome: 'uncertain' as const };
      }
      await this.deps.stores.record({
        changeId: e.changeId,
        teamId: p.teamId,
        invokerId: p.invokerId,
        ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}),
        approval: approval.approval,
        kind: e.params.kind,
        label: e.label,
        outcome: res.outcome,
        ...(res.location ? { location: res.location } : {}),
        ...(res.inverse ? { inverse: res.inverse } : {}),
        principal: identity,
        ...(p.automationId ? { automationId: p.automationId } : {}),
        ...(p.memoryNotes ? { memoryNotes: p.memoryNotes } : {}),
        ...(external
          ? {
              external: { ...external, ...(res.note ? { reference: res.note.slice(0, 120) } : {}) },
            }
          : {}),
        at: this.now().toISOString(),
      });
      results.push({
        changeId: e.changeId,
        kind: e.params.kind,
        label: e.label,
        outcome: res.outcome,
        ...(res.location?.permalink ? { permalink: res.location.permalink } : {}),
        undoable:
          res.outcome === 'applied' &&
          res.inverse !== undefined &&
          res.inverse.op !== 'not-reversible',
        ...(res.error ? { error: res.error.message } : {}),
        ...(res.note ? { note: res.note } : {}),
      });
    }
    await sink.landed({
      planId: p.id,
      title: renderInvocation(p.invocation),
      results,
      identity: badge,
      skipped: skipped.size,
    });
  }

  /**
   * Run an approved connector action as the approver (EXPERIENCE §10). Never auto-applied, never
   * retried; the connector's reply is shown as a short, cleaned note. Not reversible.
   */
  private async runConnectorAction(
    changeId: string,
    p: Extract<ActuationParams, { kind: 'connector-action' }>,
    tokens: TokenSource | undefined,
    approval: 'human' | 'auto',
  ): Promise<ActuationResult> {
    const base = { changeId, kind: p.kind, provenancePersisted: false } as const;
    const inverse = {
      op: 'not-reversible' as const,
      reason: 'Connector actions run outside Slack.',
    };
    if (approval !== 'human' || !tokens || !this.deps.connectors) {
      return {
        ...base,
        outcome: 'rejected',
        error: { code: 'not_allowed', message: 'Connector actions need a person to approve them.' },
      };
    }
    const r = await this.deps.connectors.callTool(tokens, p.collection, p.tool, p.arguments);
    if (!r.ok) {
      if (r.uncertain) {
        // It may have run: never say "failed" (a retry could act twice) (F6).
        return {
          ...base,
          outcome: 'uncertain',
          error: {
            code: r.code,
            message: `may have run — check ${p.connector} before trying again`,
          },
        };
      }
      const why =
        r.code === 'http_401' || r.code === 'http_403'
          ? `not authorized for ${p.connector} — authorize it in Gemini Enterprise and try again`
          : `${p.connector} refused it (${r.code})`;
      return { ...base, outcome: 'failed', error: { code: r.code, message: why } };
    }
    // A short reference only: the card may be visible to people without access there (F13).
    const note = r.text
      .replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return { ...base, outcome: 'applied', inverse, ...(note ? { note } : {}) };
  }

  /** Undo one landed change. Only its invoker or approver may; inverses are host-specific. */
  async undo(teamId: string, changeId: string, userId: string, sink: TurnSink): Promise<void> {
    const e = await this.deps.stores.getEntry(teamId, changeId);
    if (!e) {
      await sink.notice('info', 'No record of that change.');
      return;
    }
    if (e.invokerId !== userId && e.approvedBy !== userId) {
      await sink.notice(
        'denied',
        'Only the person who requested or approved this change can undo it.',
      );
      return;
    }
    if (e.undoneAt) {
      await sink.notice('info', 'Already undone.');
      return;
    }
    if (!e.inverse || e.inverse.op === 'not-reversible') {
      await sink.notice(
        'info',
        `${KIND_LABELS[e.kind].label} can't be undone automatically${e.inverse?.op === 'not-reversible' ? `: ${e.inverse.reason}` : ''}.`,
      );
      return;
    }
    if (
      e.inverse.op === 'delete-scheduled' &&
      e.inverse.postAt <= Math.floor(this.now().getTime() / 1000)
    ) {
      await sink.notice('info', "Sent — scheduled messages can't be cancelled after they post.");
      return;
    }
    const r = await this.deps.surface.undo(e.inverse);
    if (r.ok)
      await this.deps.stores.record({ ...e, undoneAt: this.now().toISOString(), undoneBy: userId });
    await sink.notice(r.ok ? 'info' : 'error', r.message);
  }

  /** "Share to channel": post exactly the private answer that was shown, with provenance. */
  async share(turnId: string, userId: string, sink: TurnSink): Promise<void> {
    const a = await this.deps.stores.getAnswer(turnId);
    if (!a || a.invokerId !== userId || a.shareable === false) {
      await sink.notice('info', 'That answer is no longer available to share.');
      return;
    }
    const channel = a.origin.channelId;
    if (!channel || !(await this.deps.surface.isMember(channel, userId))) {
      await sink.notice('denied', "You can't post in that conversation.");
      return;
    }
    // A user-grounded answer may quote sources external members can't open (H3).
    if (
      !a.principal.startsWith('service:') &&
      (await this.deps.surface.conversationInfo(channel)).isExtShared
    ) {
      await sink.notice(
        'denied',
        "Answers made with your identity can't be shared into an externally shared channel.",
      );
      return;
    }
    // The stored answer was sanitized when it was produced; truncate only.
    const text = a.text.slice(0, 3900) || '(empty answer)';
    const params: ActuationParams = a.origin.threadTs
      ? { kind: 'reply', channel, threadTs: a.origin.threadTs, text }
      : { kind: 'post', channel, text };
    const pending: PendingPlan = {
      id: this.newId(),
      teamId: a.teamId,
      invokerId: userId,
      origin: a.origin,
      invocation: {
        verb: 'ask',
        inferredVerb: false,
        grounds: [],
        people: [],
        from: [],
        instruction: '',
        flags: {},
      },
      scope: { kind: 'none' },
      effects: [
        {
          changeId: `chg_${randomUUID()}`,
          params,
          line: 'share',
          label: `Share answer in <#${channel}>`,
          preview: text.slice(0, 140),
          approvalClass: 'in-conversation',
          reversible: true,
        },
      ],
      sources: a.provenance?.sources ?? [],
      agentId: a.provenance?.agentId ?? 'gemini-enterprise',
      contentHash: a.provenance?.contentHash ?? (await contentHash(a.text)),
      identity: a.principal,
      dryRun: false,
      createdAt: this.now().getTime(),
      expiresAt: this.now().getTime() + PLAN_TTL_MS,
    };
    const kind = a.principal.startsWith('service:') ? 'service' : 'user';
    await this.apply(
      pending,
      a.principal,
      { kind, label: a.principal.replace(/^(user|service):/, '') },
      sink,
      { approval: 'human', approvedBy: userId },
    );
  }

  // ------------------------------------------------------------------ automations

  private async draftAutomation(
    trigger: Parameters<NonNullable<OrchestratorDeps['automations']>['nextRun']>[0],
    inv: Invocation,
    origin: Origin,
    sink: TurnSink,
  ): Promise<void> {
    const automations = this.deps.automations;
    if (!automations) {
      await sink.notice('error', 'Automations are not enabled in this workspace.');
      return;
    }
    if (!origin.channelId) {
      await sink.notice('error', 'Create automations from the channel they should run in.');
      return;
    }
    const channel = origin.channelId;
    if (!(await this.deps.surface.isMember(channel, origin.userId))) {
      await sink.notice('denied', `You're not a member of <#${channel}>.`);
      return;
    }
    if (inv.flags.to && !(await this.deps.surface.isMember(inv.flags.to, origin.userId))) {
      await sink.notice('denied', `You're not a member of <#${inv.flags.to}>.`);
      return;
    }
    const runAs = inv.flags.as === 'me' ? 'me' : 'service';
    // Reaction/keyword triggers let *any* channel member start a run; they never run as a person (H5).
    if (runAs === 'me' && (trigger.kind === 'reaction' || trigger.kind === 'keyword')) {
      await sink.notice(
        'denied',
        'Reaction and keyword automations always run as the Gemini service, because anyone in the channel can trigger them. Remove --as me.',
      );
      return;
    }
    const policy = await this.deps.config.channelPolicy(origin.teamId, channel);
    const info = await this.deps.surface.conversationInfo(channel);
    const pre = await this.deps.identity.resolve({
      teamId: origin.teamId,
      userId: origin.userId,
      policy: policy.identity,
      requested: runAs,
      unattended: true,
      externallyShared: Boolean(origin.externallyShared || info.isExtShared),
    });
    if (!pre.ok) {
      await sink.notice('denied', `This automation couldn't run: ${pre.decision.message}`);
      return;
    }
    if (pre.principal.kind === 'service' && !policy.serviceMayRead) {
      await sink.notice(
        'denied',
        `The Gemini service isn't allowed to read <#${channel}>; ask an admin, or use --as me.`,
      );
      return;
    }
    const t =
      trigger.kind === 'keyword'
        ? { ...trigger, channel }
        : trigger.kind === 'reaction'
          ? { ...trigger, channel }
          : trigger;
    const id = this.newId();
    await this.deps.stores.saveAutomationDraft({
      id,
      teamId: origin.teamId,
      invokerId: origin.userId,
      channelId: channel,
      trigger: t,
      invocation: inv,
      runAs,
      ...(inv.flags.to ? { destination: inv.flags.to } : {}),
      expiresAt: this.now().getTime() + PLAN_TTL_MS,
    });
    const next = automations.nextRun(t, this.now());
    await sink.automationPlan({
      pendingId: id,
      trigger: t,
      grammar: renderInvocation(inv),
      runAs,
      ...(inv.flags.to ? { destination: inv.flags.to } : {}),
      ...(next ? { nextRun: next.toISOString() } : {}),
      invokerId: origin.userId,
      channelId: channel,
    });
  }

  async confirmAutomation(draftId: string, userId: string, sink: TurnSink): Promise<void> {
    const peek = await this.deps.stores.getAutomationDraft(draftId);
    if (!peek || peek.invokerId !== userId) {
      await sink.notice('info', 'That automation draft expired — create it again.');
      return;
    }
    const d = await this.deps.stores.takeAutomationDraft(draftId);
    if (!d) {
      await sink.notice('info', 'That automation draft expired — create it again.');
      return;
    }
    const a = await this.deps.automations!.create({
      teamId: d.teamId,
      ownerId: d.invokerId,
      channelId: d.channelId,
      trigger: d.trigger,
      invocation: d.invocation,
      runAs: d.runAs,
      ...(d.destination ? { destination: d.destination } : {}),
      enabled: true,
    });
    await sink.notice('info', `Automation created (${a.id}). Manage it from the Gemini App Home.`);
  }

  private title(inv: Invocation, scope: ResolvedScope, name?: string): string {
    const verb = inv.verb[0]!.toUpperCase() + inv.verb.slice(1);
    const where =
      scope.kind === 'channel'
        ? ` #${name ?? 'channel'} · last ${Math.round(scope.sinceMs / 86_400_000) || 1}d`
        : scope.kind === 'thread'
          ? ' this thread'
          : scope.kind === 'message'
            ? ' a message'
            : scope.kind === 'canvas'
              ? ' a canvas'
              : '';
    return `${verb}${where}`;
  }
}

function asWho(p: Principal): string {
  return p.kind === 'user' ? 'as you' : 'as the Gemini service';
}

function effectKind(e: { kind: string }): ActuationParams['kind'] {
  return (e.kind === 'action-item' ? 'action-items' : e.kind) as ActuationParams['kind'];
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Set(a.map((s) => s.uri ?? s.title));
  return [...a, ...b.filter((s) => !seen.has(s.uri ?? s.title))];
}

function targetChannels(p: ActuationParams): string[] {
  switch (p.kind) {
    case 'action-items':
      return [p.channel];
    case 'reply':
    case 'post':
    case 'schedule':
    case 'bookmark':
    case 'react':
      return [p.channel];
    case 'canvas':
      return p.shareTo ? [p.shareTo] : [];
    default:
      return [];
  }
}

function mentionedUsers(p: ActuationParams): string[] {
  const text = 'text' in p ? p.text : 'markdown' in p ? p.markdown : '';
  return [...text.matchAll(/<@([UW][A-Z0-9]+)>/g)]
    .map((m) => m[1]!)
    .concat(p.kind === 'remind' ? [p.user] : []);
}

function withText(p: ActuationParams, text: string): ActuationParams {
  if ('text' in p) return { ...p, text };
  if ('markdown' in p) return { ...p, markdown: text };
  return p;
}

function friendlyProviderError(code: string): string {
  if (code === 'http_403')
    return 'Gemini Enterprise refused the request (403). Check that this identity has a Gemini Enterprise licence and access to the selected sources.';
  if (code === 'http_429')
    return 'Gemini Enterprise is rate-limiting requests. Try again in a minute.';
  if (code === 'incomplete') return 'The response was cut off before it finished. Try again.';
  if (code.startsWith('http_5'))
    return 'Gemini Enterprise is temporarily unavailable. Try again shortly.';
  // Provider bodies can echo request details; only the code is shown (L2).
  return `Gemini Enterprise returned an error (${code.replace(/[^\w-]/g, '').slice(0, 40)}).`;
}

export function safeMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Never echo anything that looks like a bearer credential.
  return m.replace(/(ya29\.|xox[abpr]-|eyJ)[\w.-]+/g, '[redacted]').slice(0, 300);
}

/** Connector names come from the engine: one bounded line, no control characters (escaped at render). */
function displayName(raw: string): string {
  const one = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return one || 'a connector';
}

/** A fixed job label: the agent's admin-set title and where it runs — never captured content. */
function jobTitle(agentTitle: string, origin: Origin): string {
  return `${mrkdwnEscape(agentTitle)}${origin.channelId ? ` in <#${origin.channelId}>` : ''}`;
}
