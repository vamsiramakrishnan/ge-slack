import { z } from 'zod';
import { IntentSchema } from './intent.js';
import { extractFence } from './cmd.js';

/**
 * The planner's ```plan block (ge-msft `command-plan.ts`), with `surface slack`. The planner turns
 * free text into this confirmable intent; it never touches Slack.
 *
 *   intent ask|summarize|explain|rewrite|review|draft|notes
 *   surface slack
 *   scope thread|channel|message|canvas|dm|search [ref]
 *   ground "title"
 *   step <intention>
 *   exclude <carve-out>
 *   clarify <question>
 *   confidence high|medium|low
 */
export const CommandPlanSchema = z.object({
  intent: IntentSchema,
  surface: z.literal('slack'),
  scope: z.object({ kind: z.string(), ref: z.string().optional() }).optional(),
  ground: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
  clarify: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});
export type CommandPlan = z.infer<typeof CommandPlanSchema>;

export type PlanParse =
  { ok: true; plan: CommandPlan; needsClarification: boolean } | { ok: false; error: string };

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

export function parsePlanBlock(response: string): PlanParse {
  const fence = extractFence(response, 'plan');
  if (!fence.ok) return { ok: false, error: fence.reason };
  const draft: Record<string, unknown> & {
    ground: string[];
    steps: string[];
    excludes: string[];
    clarify: string[];
  } = { ground: [], steps: [], excludes: [], clarify: [] };
  for (const raw of fence.body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'plan' || line === 'end') continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const value = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (key) {
      case 'intent':
      case 'surface':
      case 'confidence':
        draft[key] = value.toLowerCase();
        break;
      case 'scope': {
        const [kind, ...ref] = value.split(/\s+/);
        draft.scope = { kind: kind ?? '', ...(ref.length ? { ref: ref.join(' ') } : {}) };
        break;
      }
      case 'ground':
        draft.ground.push(unquote(value));
        break;
      case 'step':
        draft.steps.push(value);
        break;
      case 'exclude':
        draft.excludes.push(value);
        break;
      case 'clarify':
        draft.clarify.push(value);
        break;
      default:
        return { ok: false, error: `unknown plan key "${key}"` };
    }
  }
  const parsed = CommandPlanSchema.safeParse(draft);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid plan' };
  const plan = parsed.data;
  if (plan.steps.length === 0 && plan.clarify.length === 0) {
    return { ok: false, error: 'a plan needs at least one step or a clarify question' };
  }
  return { ok: true, plan, needsClarification: plan.clarify.length > 0 };
}

/** Render the confirmed plan as the executor's `<confirmed_plan>` block (ge-msft parity). */
export function renderConfirmedPlan(plan: CommandPlan): string {
  return [
    '<confirmed_plan>',
    'The user approved this intent only. Do not widen scope or add effects beyond it.',
    `intent ${plan.intent}`,
    ...(plan.scope
      ? [`scope ${plan.scope.kind}${plan.scope.ref ? ` ${plan.scope.ref}` : ''}`]
      : []),
    ...plan.ground.map((g) => `ground "${g}"`),
    ...plan.steps.map((s) => `step ${s}`),
    ...plan.excludes.map((e) => `exclude ${e}`),
    '</confirmed_plan>',
  ].join('\n');
}
