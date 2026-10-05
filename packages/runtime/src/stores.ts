import type {
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
  /** Unattended run awaiting the owner (automation gate). */
  automationId?: string;
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
}

export interface LedgerEntry {
  changeId: string;
  teamId: string;
  invokerId: string;
  approvedBy?: string;
  approval: 'human' | 'auto';
  kind: ActuationKind;
  label: string;
  outcome: ActuationOutcome;
  location?: ActuationResult['location'];
  inverse?: Inverse;
  principal: string;
  automationId?: string;
  at: string;
  undoneAt?: string;
  undoneBy?: string;
}

export class RuntimeStores {
  constructor(private readonly kv: KeyValueStore) {}

  savePlan(p: PendingPlan) {
    return this.kv.set(`plan/${p.id}`, p, { ttlMs: Math.max(1, p.expiresAt - p.createdAt) });
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

  saveAnswer(a: StoredAnswer) {
    return this.kv.set(`answer/${a.turnId}`, a, { ttlMs: ANSWER_TTL_MS });
  }
  getAnswer(id: string) {
    return this.kv.get<StoredAnswer>(`answer/${id}`);
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

  recordFeedback(teamId: string, turnId: string, userId: string, value: 'positive' | 'negative') {
    return this.kv.set(`feedback/${teamId}/${turnId}/${userId}`, {
      value,
      at: new Date().toISOString(),
    });
  }
}
