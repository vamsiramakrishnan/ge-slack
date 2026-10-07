import type {
  ChannelNote,
  AgentHandle,
  AwaitingReason,
  ActuationKind,
  ActuationOutcome,
  ActuationResult,
  AnswerProvenance,
  Inverse,
  Invocation,
  Origin,
  SourceRef,
  Trigger,
} from '@ge-slack/contracts';
import type { KeyValueStore } from '@ge-slack/identity';
import type { CompiledEffect } from './compile.js';
import type { ResolvedScope } from './ports.js';

export const PLAN_TTL_MS = 30 * 60_000;
export const RESUME_TTL_MS = 10 * 60_000;
export const ANSWER_TTL_MS = 24 * 3_600_000;

/** A plan awaiting approval. Only `invokerId` may approve; it expires after `PLAN_TTL_MS`. */
export interface PendingPlan {
  id: string;
  teamId: string;
  invokerId: string;
  origin: Origin;
  invocation: Invocation;
  scope: ResolvedScope;
  effects: CompiledEffect[];
  sources: SourceRef[];
  agentId: string;
  contentHash: string;
  /** Principal that drafted the content (`user:…` / `service:…`). Approval must match it. */
  identity: string;
  /** Channel notes that grounded the drafting turn (shown on the card, kept in the ledger). */
  memoryNotes?: number;
  /** changeIds the approver unticked (review findings). */
  skipped?: string[];
  /** Unattended run awaiting the owner (automation gate). */
  automationId?: string;
  /** Drafted as the owner under a delegation grant ending then (ADR-0003 §4). */
  grantExpiresAt?: string;
  dryRun: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface PendingAutomation {
  id: string;
  teamId: string;
  invokerId: string;
  channelId: string;
  trigger: Trigger;
  invocation: Invocation;
  runAs: 'me' | 'service';
  destination?: string;
  expiresAt: number;
}

/** A finished private answer, kept briefly so "Share" can post exactly what was shown. */
export interface StoredAnswer {
  turnId: string;
  teamId: string;
  invokerId: string;
  origin: Origin;
  text: string;
  provenance?: AnswerProvenance;
  principal: string;
  /** False for answers that must stay private (e.g. workspace search). */
  shareable?: boolean;
  /** What was asked (the request text), for *Save as FAQ* (ADR-0003 §5). */
  question?: string;
  /** Citation URIs of the answer. */
  sourceUris?: string[];
}

/**
 * An agent turn paused for its invoker (ADR-0002). Only the invoker may continue it, once, under
 * the same principal. The agent's own session/context carries the conversation, so no Slack
 * content is stored here, and the origin is stored without its response_url / trigger_id.
 */
export interface AgentContinuation {
  id: string;
  teamId: string;
  invokerId: string;
  origin: Origin;
  invocation: Invocation;
  agentAlias: string;
  agentId: string;
  reason: AwaitingReason;
  handle: AgentHandle;
  identity: string;
  expiresAt: number;
}

export interface LedgerEntry {
  changeId: string;
  teamId: string;
  invokerId: string;
  approvedBy?: string;
  approval: 'human' | 'auto' | 'trust';
  /** Run as the automation owner under a delegation grant ending then (ADR-0003 §4). */
  grantExpiresAt?: string;
  kind: ActuationKind;
  label: string;
  outcome: ActuationOutcome;
  location?: ActuationResult['location'];
  inverse?: Inverse;
  principal: string;
  automationId?: string;
  /** Channel notes that grounded the drafting turn. */
  memoryNotes?: number;
  /** Connector actions: what ran where (no argument values — a hash of them). */
  external?: {
    connector: string;
    collection: string;
    tool: string;
    argsHash: string;
    /** Short reference from the connector's reply (e.g. a ticket key). */
    reference?: string;
  };
  at: string;
  undoneAt?: string;
  undoneBy?: string;
}

export class RuntimeStores {
  /** The shared store (feature modules keep their own keys under their own prefixes). */
  constructor(readonly kv: KeyValueStore) {}

  savePlan(p: PendingPlan, now = p.createdAt) {
    // TTL counts from now so a re-save (e.g. a finding toggle) never extends the plan's life.
    return this.kv.set(`plan/${p.id}`, p, {
      ttlMs: Math.max(1, p.expiresAt - Math.min(now, p.expiresAt - 1)),
    });
  }
  getPlan(id: string) {
    return this.kv.get<PendingPlan>(`plan/${id}`);
  }
  /** Approve/cancel consume the plan exactly once (no double-apply on double-click). */
  takePlan(id: string) {
    return this.kv.take<PendingPlan>(`plan/${id}`);
  }

  saveAutomationDraft(a: PendingAutomation) {
    return this.kv.set(`automation-draft/${a.id}`, a, { ttlMs: PLAN_TTL_MS });
  }
  getAutomationDraft(id: string) {
    return this.kv.get<PendingAutomation>(`automation-draft/${id}`);
  }
  takeAutomationDraft(id: string) {
    return this.kv.take<PendingAutomation>(`automation-draft/${id}`);
  }

  saveResume(id: string, value: { origin: Origin; invocation: Invocation }) {
    return this.kv.set(`resume/${id}`, value, { ttlMs: RESUME_TTL_MS });
  }
  getResume(id: string) {
    return this.kv.get<{ origin: Origin; invocation: Invocation }>(`resume/${id}`);
  }
  takeResume(id: string) {
    return this.kv.take<{ origin: Origin; invocation: Invocation }>(`resume/${id}`);
  }

  /** One key per note, so concurrent `remember`s never overwrite each other. */
  saveNote(teamId: string, n: ChannelNote) {
    // Forgotten notes stay visible (who/when) for 30 days, then disappear.
    // Live notes expire after MEMORY_LIMITS.ttlDays (90); notesFor also filters by age.
    return this.kv.set(`memory/${teamId}/${n.channel}/${n.id}`, n, {
      ttlMs: (n.forgottenAt ? 30 : 90) * 24 * 3_600_000,
    });
  }
  async notes(teamId: string, channel: string): Promise<ChannelNote[]> {
    const all = await this.kv.list<ChannelNote>(`memory/${teamId}/${channel}/`);
    return all.map((x) => x.value).sort((a, b) => a.at.localeCompare(b.at));
  }

  saveContinuation(c: AgentContinuation, now: number) {
    return this.kv.set(`agent/${c.id}`, c, { ttlMs: Math.max(1, c.expiresAt - now) });
  }
  getContinuation(id: string) {
    return this.kv.get<AgentContinuation>(`agent/${id}`);
  }
  takeContinuation(id: string) {
    return this.kv.take<AgentContinuation>(`agent/${id}`);
  }

  saveAnswer(a: StoredAnswer) {
    return this.kv.set(`answer/${a.turnId}`, a, { ttlMs: ANSWER_TTL_MS });
  }
  getAnswer(id: string) {
    return this.kv.get<StoredAnswer>(`answer/${id}`);
  }

  /** Team-wide ledger since a time (admin export). */
  async ledgerSince(teamId: string, sinceMs: number): Promise<LedgerEntry[]> {
    const all = await this.kv.list<LedgerEntry>(`ledger/${teamId}/`);
    return all
      .map((x) => x.value)
      .filter((e) => Date.parse(e.at) >= sinceMs)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  record(e: LedgerEntry) {
    return this.kv.set(`ledger/${e.teamId}/${e.changeId}`, e);
  }
  getEntry(teamId: string, changeId: string) {
    return this.kv.get<LedgerEntry>(`ledger/${teamId}/${changeId}`);
  }
  async recent(teamId: string, userId: string, limit = 10): Promise<LedgerEntry[]> {
    const all = await this.kv.list<LedgerEntry>(`ledger/${teamId}/`);
    return all
      .map((x) => x.value)
      .filter((e) => e.invokerId === userId || e.approvedBy === userId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  getFeedback(teamId: string, turnId: string, userId: string) {
    return this.kv.get<{ value: string }>(`feedback/${teamId}/${turnId}/${userId}`);
  }
  recordFeedback(teamId: string, turnId: string, userId: string, value: 'positive' | 'negative') {
    return this.kv.set(`feedback/${teamId}/${turnId}/${userId}`, {
      value,
      at: new Date().toISOString(),
    });
  }
}
