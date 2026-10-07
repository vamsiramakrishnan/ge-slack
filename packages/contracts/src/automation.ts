import { z } from 'zod';
import { InvocationSchema, RunAsSchema } from './invocation.js';
import { DelegationGrantSchema } from './delegation.js';

/**
 * Automation triggers. Schedules are kept as the user's text plus a normalized cron so the card can
 * show exactly what they typed; the automations package owns next-run computation.
 */
export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('schedule'),
    text: z.string().min(1).max(100),
    /** 5-field cron, minute hour dom month dow, in `timeZone`. */
    cron: z.string().regex(/^(\S+\s+){4}\S+$/),
    timeZone: z.string().default('UTC'),
  }),
  z.object({
    kind: z.literal('reaction'),
    emoji: z.string().regex(/^[a-z0-9_+'-]{1,80}$/),
    channel: z.string().optional(),
  }),
  z.object({
    kind: z.literal('keyword'),
    /** Source of a case-insensitive RegExp, bounded and validated by the parser. */
    pattern: z.string().min(1).max(200),
    channel: z.string(),
  }),
  z.object({ kind: z.literal('workflow'), step: z.string() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const AutomationSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  ownerId: z.string(),
  /** Conversation the automation was created in; default capture scope and destination. */
  channelId: z.string(),
  trigger: TriggerSchema,
  invocation: InvocationSchema,
  runAs: RunAsSchema,
  /** Where unattended output goes. Defaults to the triggering conversation/thread. */
  destination: z.string().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  lastOutcome: z.enum(['ok', 'gated', 'denied', 'failed']).optional(),
  /** Why it was paused automatically (owner disconnected, left channel, repeated failure). */
  suspendedReason: z.string().optional(),
  /** Permission to run as the owner (ADR-0003 §4); required for run-as-me with `delegation`. */
  grant: DelegationGrantSchema.optional(),
  /** A built-in kind of run instead of the stored invocation (ADR-0003 §3). */
  template: z.enum(['brief']).optional(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case 'schedule':
      return `⏰ ${t.text}`;
    case 'reaction':
      return `:${t.emoji}: reaction`;
    case 'keyword':
      return `messages matching /${t.pattern}/`;
    case 'workflow':
      return `Workflow step “${t.step}”`;
  }
}
