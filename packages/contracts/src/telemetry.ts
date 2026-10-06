import { z } from 'zod';

/**
 * Admin insights (EXPERIENCE §10): one record per outcome, with **no message content and no user
 * or conversation identities** — verbs, principal kinds, agent titles, outcome and reason codes,
 * and the day it happened. (A DM id would identify a pair of people, so channels aren't kept.)
 */
export const TelemetryKindSchema = z.enum([
  'turn',
  'plan',
  'apply',
  'memory',
  'agent',
  'feedback',
  'job',
  'connector-action',
  'licence',
]);

export const TelemetryEventSchema = z.object({
  kind: TelemetryKindSchema,
  /** answered | planned | applied | failed | denied | blocked | error | paused | added | … */
  outcome: z.string().regex(/^[a-z-]{1,32}$/),
  verb: z.string().max(16).optional(),
  principal: z.enum(['user', 'service']).optional(),
  agent: z.string().max(64).optional(),
  /** Short machine reason for denials/errors (e.g. `not-member`, `http_403`), never free text. */
  reason: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .optional(),
  entry: z.string().max(24).optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
/** `at` is the UTC day only (YYYY-MM-DD). */
export type TelemetryRecord = TelemetryEvent & { at: string; teamId: string };

export interface InsightsSummary {
  days: number;
  turns: number;
  byVerb: Record<string, number>;
  byPrincipal: Record<string, number>;
  byAgent: Record<string, number>;
  outcomes: Record<string, number>;
  feedback: { up: number; down: number };
  denials: Array<{ reason: string; count: number }>;
}

/** Aggregate records into the App Home / `/gemini stats` summary (pure). */
export function summarize(records: TelemetryRecord[], days: number): InsightsSummary {
  const inc = (m: Record<string, number>, k: string | undefined) => {
    if (k) m[k] = (m[k] ?? 0) + 1;
  };
  const s: InsightsSummary = {
    days,
    turns: 0,
    byVerb: {},
    byPrincipal: {},
    byAgent: {},
    outcomes: {},
    feedback: { up: 0, down: 0 },
    denials: [],
  };
  const denials: Record<string, number> = {};
  for (const r of records) {
    if (r.kind === 'feedback') {
      if (r.outcome === 'up') s.feedback.up++;
      else if (r.outcome === 'down') s.feedback.down++;
      continue;
    }
    if (r.kind === 'turn') {
      s.turns++;
      inc(s.byVerb, r.verb);
      inc(s.byPrincipal, r.principal);
      inc(s.byAgent, r.agent);
    }
    inc(s.outcomes, `${r.kind}:${r.outcome}`);
    if (r.outcome === 'denied') inc(denials, r.reason ?? 'unspecified');
  }
  s.denials = Object.entries(denials)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return s;
}
