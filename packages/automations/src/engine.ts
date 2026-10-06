import { randomUUID } from 'node:crypto';
import {
  AutomationSchema,
  type Automation,
  type Invocation,
  type Origin,
  type Trigger,
} from '@ge-slack/contracts';
import type { KeyValueStore } from '@ge-slack/identity';
import type { AutomationPort, Orchestrator, TurnSink } from '@ge-slack/runtime';
import { nextCronRun } from './cron.js';

export const MAX_AUTOMATIONS_PER_OWNER = 25;
const REACTION_DEBOUNCE_MS = 10 * 60_000;
const KEYWORD_DEBOUNCE_MS = 2 * 60_000;
const SUSPEND_AFTER_FAILURES = 3;

export interface UnattendedSinkFactory {
  (a: Automation, opts: { threadTs?: string }): TurnSink;
}

/**
 * Automations engine: persistence (implements the runtime's `AutomationPort`), the schedule tick,
 * and event triggers. Every run goes through the same `Orchestrator.run` as an interactive turn,
 * with an unattended origin — so principal policy, membership, and the auto-apply gate all apply.
 */
export class AutomationEngine implements AutomationPort {
  private readonly debounce = new Map<string, number>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => `auto_${randomUUID().slice(0, 12)}`,
  ) {}

  private key(teamId: string, id: string) {
    return `automation/${teamId}/${id}`;
  }

  nextRun(trigger: Trigger, from: Date): Date | undefined {
    return trigger.kind === 'schedule'
      ? nextCronRun(trigger.cron, from, trigger.timeZone)
      : undefined;
  }

  async create(a: Omit<Automation, 'id' | 'createdAt'>): Promise<Automation> {
    const mine = await this.list(a.teamId, a.ownerId);
    if (mine.length >= MAX_AUTOMATIONS_PER_OWNER) {
      throw new Error(
        `You already have ${MAX_AUTOMATIONS_PER_OWNER} automations; delete one first.`,
      );
    }
    const full = AutomationSchema.parse({
      ...a,
      id: this.newId(),
      createdAt: this.now().toISOString(),
    });
    await this.kv.set(this.key(full.teamId, full.id), full);
    if (full.trigger.kind === 'schedule') {
      const next = this.nextRun(full.trigger, this.now());
      if (next) await this.kv.set(`automation-next/${full.teamId}/${full.id}`, next.toISOString());
    }
    return full;
  }

  async get(teamId: string, id: string): Promise<Automation | undefined> {
    return this.kv.get<Automation>(this.key(teamId, id));
  }

  async list(teamId: string, ownerId?: string): Promise<Automation[]> {
    const all = await this.kv.list<Automation>(`automation/${teamId}/`);
    return all.map((x) => x.value).filter((a) => !ownerId || a.ownerId === ownerId);
  }

  async update(a: Automation): Promise<void> {
    await this.kv.set(this.key(a.teamId, a.id), AutomationSchema.parse(a));
  }

  /** Owner-only management actions from App Home. */
  async manage(
    teamId: string,
    id: string,
    userId: string,
    op: 'toggle' | 'delete',
  ): Promise<string> {
    const a = await this.get(teamId, id);
    if (!a) return 'That automation no longer exists.';
    if (a.ownerId !== userId) return 'Only the owner can change this automation.';
    if (op === 'delete') {
      await this.kv.delete(this.key(teamId, id));
      await this.kv.delete(`automation-next/${teamId}/${id}`);
      return 'Automation deleted.';
    }
    const enabled = !a.enabled;
    const { suspendedReason: _s, ...rest } = a;
    await this.update({ ...rest, enabled });
    if (enabled && a.trigger.kind === 'schedule') {
      const next = this.nextRun(a.trigger, this.now());
      if (next) await this.kv.set(`automation-next/${teamId}/${id}`, next.toISOString());
    }
    return enabled ? 'Automation resumed.' : 'Automation paused.';
  }

  /** Suspend every automation an owner runs as themselves (on disconnect / revocation). */
  async suspendOwner(teamId: string, ownerId: string, reason: string): Promise<number> {
    let n = 0;
    for (const a of await this.list(teamId, ownerId)) {
      if (a.runAs === 'me' && a.enabled) {
        await this.update({ ...a, enabled: false, suspendedReason: reason });
        n++;
      }
    }
    return n;
  }

  private originFor(a: Automation, entry: Origin['entry'], extra: Partial<Origin> = {}): Origin {
    return {
      entry,
      teamId: a.teamId,
      userId: a.ownerId,
      channelId: a.channelId,
      automationId: a.id,
      ...extra,
    };
  }

  private invocationFor(a: Automation): Invocation {
    return {
      ...a.invocation,
      flags: {
        ...a.invocation.flags,
        as: a.runAs,
        ...(a.destination ? { to: a.destination } : {}),
        visibility: 'public',
      },
    };
  }

  private async execute(
    orch: Orchestrator,
    a: Automation,
    origin: Origin,
    sinkFor: UnattendedSinkFactory,
  ): Promise<void> {
    const sink = sinkFor(a, origin.threadTs ? { threadTs: origin.threadTs } : {});
    const outcome = new OutcomeSink(sink);
    try {
      await orch.run(this.invocationFor(a), origin, outcome);
    } catch {
      outcome.outcome = 'failed';
    }
    const fresh = (await this.get(a.teamId, a.id)) ?? a;
    const failures =
      outcome.outcome === 'failed' || outcome.outcome === 'denied'
        ? (this.failures.get(a.id) ?? 0) + 1
        : 0;
    this.failures.set(a.id, failures);
    await this.update({
      ...fresh,
      lastRunAt: this.now().toISOString(),
      lastOutcome: outcome.outcome,
      ...(failures >= SUSPEND_AFTER_FAILURES
        ? {
            enabled: false,
            suspendedReason: `paused after ${failures} failed runs (${outcome.lastMessage ?? outcome.outcome})`,
          }
        : {}),
    });
  }

  private readonly failures = new Map<string, number>();

  /**
   * Run every due schedule. Advances `next` *before* executing so a retried tick (Cloud
   * Scheduler at-least-once delivery) cannot double-run the same slot.
   */
  async tick(
    orch: Orchestrator,
    teamId: string,
    sinkFor: UnattendedSinkFactory,
  ): Promise<string[]> {
    const ran: string[] = [];
    const now = this.now();
    for (const { key, value } of await this.kv.list<string>(`automation-next/${teamId}/`)) {
      if (Date.parse(value) > now.getTime()) continue;
      const id = key.split('/').at(-1)!;
      const a = await this.get(teamId, id);
      if (!a || !a.enabled || a.trigger.kind !== 'schedule') {
        await this.kv.delete(key);
        continue;
      }
      const next = this.nextRun(a.trigger, now);
      if (next) await this.kv.set(key, next.toISOString());
      else await this.kv.delete(key);
      await this.execute(orch, a, this.originFor(a, 'schedule'), sinkFor);
      ran.push(id);
    }
    return ran;
  }

  async runNow(
    orch: Orchestrator,
    teamId: string,
    id: string,
    userId: string,
    sinkFor: UnattendedSinkFactory,
  ): Promise<string> {
    const a = await this.get(teamId, id);
    if (!a) return 'That automation no longer exists.';
    if (a.ownerId !== userId) return 'Only the owner can run this automation.';
    await this.execute(orch, a, this.originFor(a, 'schedule'), sinkFor);
    return 'Ran it — check the destination channel.';
  }

  private debounced(key: string, windowMs: number): boolean {
    const now = this.now().getTime();
    const last = this.debounce.get(key);
    if (last !== undefined && now - last < windowMs) return true;
    this.debounce.set(key, now);
    if (this.debounce.size > 10_000) this.debounce.clear();
    return false;
  }

  /** `reaction_added` on a message → matching reaction automations run on that message's thread. */
  async onReaction(
    orch: Orchestrator,
    ev: {
      teamId: string;
      channel: string;
      ts: string;
      threadTs?: string;
      emoji: string;
      userId: string;
    },
    sinkFor: UnattendedSinkFactory,
  ): Promise<number> {
    const matches = (await this.list(ev.teamId)).filter(
      (a) =>
        a.enabled &&
        a.trigger.kind === 'reaction' &&
        a.runAs === 'service' && // event triggers never run as a person (H5)
        a.trigger.emoji === ev.emoji &&
        (!a.trigger.channel || a.trigger.channel === ev.channel),
    );
    let n = 0;
    for (const a of matches) {
      if (this.debounced(`r:${a.id}:${ev.channel}:${ev.ts}`, REACTION_DEBOUNCE_MS)) continue;
      const threadTs = ev.threadTs ?? ev.ts;
      await this.execute(
        orch,
        a,
        this.originFor(a, 'reaction', { channelId: ev.channel, threadTs }),
        sinkFor,
      );
      n++;
    }
    return n;
  }

  /** New human message in a channel → keyword automations bound to that channel. */
  async onMessage(
    orch: Orchestrator,
    ev: {
      teamId: string;
      channel: string;
      ts: string;
      threadTs?: string;
      text: string;
      userId?: string;
      fromBot: boolean;
    },
    sinkFor: UnattendedSinkFactory,
  ): Promise<number> {
    if (ev.fromBot || !ev.userId) return 0; // never trigger on bots (incl. ourselves): no loops
    const matches = (await this.list(ev.teamId)).filter(
      (a) =>
        a.enabled &&
        a.runAs === 'service' &&
        a.trigger.kind === 'keyword' &&
        a.trigger.channel === ev.channel &&
        safeTest(a.trigger.pattern, ev.text),
    );
    let n = 0;
    for (const a of matches) {
      if (this.debounced(`k:${a.id}:${ev.threadTs ?? ev.ts}`, KEYWORD_DEBOUNCE_MS)) continue;
      await this.execute(
        orch,
        a,
        this.originFor(a, 'keyword', { channelId: ev.channel, threadTs: ev.threadTs ?? ev.ts }),
        sinkFor,
      );
      n++;
    }
    return n;
  }
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text.slice(0, 4000));
  } catch {
    return false;
  }
}

/** Wraps a sink to learn how an unattended run ended (for lastOutcome + auto-suspend). */
export class OutcomeSink implements TurnSink {
  outcome: NonNullable<Automation['lastOutcome']> = 'ok';
  lastMessage?: string;
  constructor(private readonly inner: TurnSink) {}
  begin(t: string) {
    return this.inner.begin(t);
  }
  task(t: Parameters<TurnSink['task']>[0]) {
    return this.inner.task(t);
  }
  token(t: string) {
    return this.inner.token(t);
  }
  answer(a: Parameters<TurnSink['answer']>[0]) {
    return this.inner.answer(a);
  }
  plan(p: Parameters<TurnSink['plan']>[0]) {
    this.outcome = 'gated';
    return this.inner.plan(p);
  }
  automationPlan(p: Parameters<TurnSink['automationPlan']>[0]) {
    return this.inner.automationPlan(p);
  }
  connect(c: Parameters<TurnSink['connect']>[0]) {
    this.outcome = 'denied';
    this.lastMessage = c.message;
    return this.inner.connect(c);
  }
  executing(p: Parameters<TurnSink['executing']>[0]) {
    return this.inner.executing(p);
  }
  landed(l: Parameters<TurnSink['landed']>[0]) {
    if (l.results.some((r) => r.outcome !== 'applied')) this.outcome = 'failed';
    return this.inner.landed(l);
  }
  retire(text: string) {
    return this.inner.retire(text);
  }
  memory(m: Parameters<TurnSink['memory']>[0]) {
    return this.inner.memory(m);
  }
  awaiting(a: Parameters<TurnSink['awaiting']>[0]) {
    // Unattended runs can't continue a paused agent (admission refuses those agents anyway).
    this.outcome = 'failed';
    return this.inner.awaiting(a);
  }
  notice(kind: Parameters<TurnSink['notice']>[0], text: string) {
    if (kind === 'denied' || kind === 'policy') this.outcome = 'denied';
    else if (kind === 'error') this.outcome = 'failed';
    this.lastMessage = text.slice(0, 120);
    return this.inner.notice(kind, text);
  }
}
