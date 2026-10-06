import { randomUUID } from 'node:crypto';
import {
  TelemetryEventSchema,
  summarize,
  type InsightsSummary,
  type Origin,
  type TelemetryEvent,
  type TelemetryRecord,
} from '@ge-slack/contracts';
import type { KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from './orchestrator.js';
import type { TelemetryPort, TurnSink } from './ports.js';
import type { LedgerEntry } from './stores.js';
import { mrkdwnEscape } from './compile.js';

const DAY_MS = 86_400_000;
const RETAIN_MS = 90 * DAY_MS;

/**
 * Admin insights store (EXPERIENCE §10). One record per outcome under a per-day prefix, so writes
 * never contend and a 7-day summary is seven prefix reads. Invalid events are dropped, never
 * stored: the schema is what guarantees "no content, no user identities".
 */
export class KvTelemetry implements TelemetryPort {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(teamId: string, e: TelemetryEvent): Promise<void> {
    const parsed = TelemetryEventSchema.safeParse(e);
    if (!parsed.success) return;
    const at = this.now();
    // Day precision only: a millisecond timestamp could re-identify who did what.
    const rec: TelemetryRecord = { ...parsed.data, at: day(at), teamId };
    await this.kv.set(`stat/${teamId}/${day(at)}/${randomUUID()}`, rec, { ttlMs: RETAIN_MS });
  }

  async summary(teamId: string, days = 7): Promise<InsightsSummary> {
    const now = this.now().getTime();
    const records: TelemetryRecord[] = [];
    for (let i = 0; i < days; i++) {
      const rows = await this.kv.list<TelemetryRecord>(
        `stat/${teamId}/${day(new Date(now - i * DAY_MS))}/`,
      );
      records.push(...rows.map((r) => r.value));
    }
    return summarize(records, days);
  }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Render the 7-day summary as Slack mrkdwn lines (also used by App Home). */
export function insightsLines(s: InsightsSummary): string[] {
  const top = (m: Record<string, number>, n = 6) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${mrkdwnEscape(k)} ${v}`)
      .join(' · ') || '—';
  const o = s.outcomes;
  const rated = s.feedback.up + s.feedback.down;
  return [
    `*Last ${s.days} days* · ${s.turns} requests`,
    `*Verbs* ${top(s.byVerb)}`,
    `*Identity* ${top(s.byPrincipal)}`,
    `*Agents* ${top(s.byAgent)}`,
    `*Outcomes* answered ${o['turn:answered'] ?? 0} · plans ${o['turn:planned'] ?? 0} · changes applied ${o['apply:applied'] ?? 0} · failed ${o['apply:failed'] ?? 0} · denied ${o['turn:denied'] ?? 0} · blocked by policy ${o['turn:blocked'] ?? 0} · errors ${o['turn:error'] ?? 0}`,
    `*Feedback* ${rated ? `👍 ${s.feedback.up} · 👎 ${s.feedback.down} (${Math.round((100 * s.feedback.up) / rated)}% positive)` : 'none yet'}`,
    `*Top denials* ${s.denials.map((d) => `${mrkdwnEscape(d.reason)} ${d.count}`).join(' · ') || 'none'}`,
  ];
}

const CSV_COLUMNS = [
  'at',
  'change_id',
  'kind',
  'outcome',
  'principal',
  'invoker',
  'approved_by',
  'approval',
  'channel',
  'permalink',
  'undone_at',
  'undone_by',
  'automation_id',
  'memory_notes',
] as const;

/**
 * Ledger export: ids, kinds, outcomes, principals, approvers, links — no content. Cells are
 * quoted, and ones a spreadsheet would read as a formula are prefixed with `'` (CSV injection).
 */
export function ledgerCsv(entries: LedgerEntry[]): string {
  const cell = (v: unknown) => {
    let s = v === undefined || v === null ? '' : String(v);
    if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = entries.map((e) =>
    [
      e.at,
      e.changeId,
      e.kind,
      e.outcome,
      e.principal,
      e.invokerId,
      e.approvedBy,
      e.approval,
      e.location?.channel,
      e.location?.permalink,
      e.undoneAt,
      e.undoneBy,
      e.automationId,
      e.memoryNotes,
    ]
      .map(cell)
      .join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/** `/gemini stats [export]` — workspace admins only. */
export async function showStats(
  orch: Orchestrator,
  origin: Origin,
  args: string[],
  sink: TurnSink,
): Promise<void> {
  if (!orch.deps.features?.has('analytics') || !orch.deps.insights) {
    await sink.notice('info', 'Admin insights are switched off for this workspace.');
    return;
  }
  if (!(await orch.deps.surface.isWorkspaceAdmin(origin.userId))) {
    await sink.notice('denied', 'Insights are for workspace admins.');
    return;
  }
  if (args[0] === 'export') {
    const since = Date.now() - 30 * DAY_MS;
    const entries = await orch.deps.stores.ledgerSince(origin.teamId, since);
    const r = await orch.deps.surface.sendFile(origin.userId, {
      name: `gemini-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
      title: 'Gemini Enterprise ledger (30 days)',
      content: ledgerCsv(entries),
      comment: `${entries.length} landed change${entries.length === 1 ? '' : 's'} in the last 30 days. Ids, outcomes and links only — no content.`,
    });
    await sink.notice(
      r.ok ? 'info' : 'error',
      r.ok ? 'The ledger export is in your DM with Gemini.' : r.message,
    );
    return;
  }
  const s = await orch.deps.insights.summary(origin.teamId, 7);
  await sink.notice(
    'info',
    [
      '*📊 Gemini insights* — no message content, no user identities',
      ...insightsLines(s),
      '_`/gemini stats export` DMs you the 30-day ledger as CSV._',
    ].join('\n'),
  );
}

/** Coarse, content-free reason codes for a denial notice (admin "top denials"). */
export function denialReason(text: string): string {
  const t = text.toLowerCase();
  if (/not a member|no longer a member/.test(t)) return 'not-member';
  if (/guests|external members/.test(t)) return 'guest';
  if (/externally shared|other organizations|slack connect/.test(t)) return 'slack-connect';
  if (/search/.test(t)) return 'search-rules';
  if (/canvas/.test(t)) return 'canvas';
  if (/gemini service|service isn't|service may not/.test(t)) return 'service-policy';
  if (/connect|link/.test(t)) return 'needs-link';
  if (/agent|one agent|answers questions|automation/.test(t)) return 'agent-rules';
  if (/only <@/.test(t)) return 'not-invoker';
  if (/licence/.test(t)) return 'no-licence';
  if (/identity/.test(t)) return 'identity-changed';
  return 'policy';
}

/**
 * Wraps a turn's sink to record its terminal outcome once (answered / planned / denied /
 * blocked / error / paused) and each landed change — from what the person was shown, so the
 * numbers match their experience. Content never leaves the sink.
 */
export function observingSink(
  orch: Orchestrator,
  teamId: string,
  base: { verb?: string; entry?: string },
  sink: TurnSink,
  opts: { turns?: boolean } = {},
): TurnSink {
  const countTurns = opts.turns !== false;
  let done = false;
  const turn = (outcome: string, extra: Partial<TelemetryEvent> = {}) => {
    if (done || !countTurns) return;
    done = true;
    orch.observe(teamId, {
      kind: 'turn',
      outcome,
      ...(base.verb ? { verb: base.verb } : {}),
      ...(base.entry ? { entry: base.entry } : {}),
      ...extra,
    });
  };
  return {
    begin: (t) => sink.begin(t),
    task: (t) => sink.task(t),
    token: (t) => sink.token(t),
    answer: (a) => {
      turn('answered', {
        principal: a.identity.kind,
        ...(a.via ? { agent: a.via.slice(0, 64) } : {}),
      });
      return sink.answer(a);
    },
    plan: (p) => {
      turn('planned', { principal: p.identity.kind });
      return sink.plan(p);
    },
    automationPlan: (p) => sink.automationPlan(p),
    connect: (c) => {
      // A connect prompt isn't a denial: the request resumes after linking.
      turn('connect');
      return sink.connect(c);
    },
    licence: (l) => {
      turn('denied', { reason: 'no-licence' });
      return sink.licence(l);
    },
    executing: (p) => sink.executing(p),
    landed: (l) => {
      // Unattended answers can land without an answer card: the turn still completed.
      turn('applied', { principal: l.identity.kind });
      for (const r of l.results) {
        orch.observe(teamId, {
          kind: 'apply',
          outcome: r.outcome === 'applied' ? 'applied' : 'failed',
          verb: r.kind,
          principal: l.identity.kind,
        });
      }
      return sink.landed(l);
    },
    notice: (kind, text) => {
      if (kind === 'denied') turn('denied', { reason: denialReason(text) });
      else if (kind === 'policy') turn('blocked');
      else if (kind === 'error') turn('error');
      return sink.notice(kind, text);
    },
    retire: (t) => sink.retire(t),
    awaiting: (a) => {
      orch.observe(teamId, { kind: 'agent', outcome: 'paused', agent: a.agentTitle.slice(0, 64) });
      return sink.awaiting(a);
    },
    memory: (m) => sink.memory(m),
  };
}
