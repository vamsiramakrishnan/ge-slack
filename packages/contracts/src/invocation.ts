import { z } from 'zod';
import { IntentSchema } from './intent.js';
import { ScopeSchema } from './scope.js';
import { GroundSchema } from './ground.js';

const UserId = z.string().regex(/^[UW][A-Z0-9]{2,}$/, 'expected a Slack user id');

export const VisibilitySchema = z.enum(['private', 'public']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const RunAsSchema = z.enum(['me', 'service']);
export type RunAs = z.infer<typeof RunAsSchema>;

export const InvocationFlagsSchema = z.object({
  /** Capture window for channel scope, in ms (parsed from `--since 7d`). */
  sinceMs: z.number().int().positive().optional(),
  /** `private` = only visible to you (ephemeral); `public` = in the conversation. */
  visibility: VisibilitySchema.optional(),
  /** Destination conversation for drafts/automations (`--to #channel`). */
  to: z.string().optional(),
  /** Requested principal (`--as me|service`). Policy may deny it; it never widens access. */
  as: RunAsSchema.optional(),
  dryRun: z.boolean().optional(),
  tone: z.enum(['formal', 'friendly', 'brief', 'neutral']).optional(),
});
export type InvocationFlags = z.infer<typeof InvocationFlagsSchema>;

/**
 * The one typed request every entry point produces (slash, mention, agent DM, shortcut, reaction,
 * workflow step, schedule). ge-msft's `Invocation`, with Slack scope/ground nouns.
 */
export const InvocationSchema = z.object({
  verb: IntentSchema,
  /** True when the user typed free text and the verb defaulted to `ask`. */
  inferredVerb: z.boolean().default(false),
  scope: ScopeSchema.optional(),
  grounds: z.array(GroundSchema).max(10).default([]),
  /** People mentioned in the request (assignees, audience). Never grounds. */
  people: z.array(UserId).max(20).default([]),
  /** `from:@person` filter for captured messages. */
  from: z.array(UserId).max(10).default([]),
  instruction: z.string().max(4000).default(''),
  flags: InvocationFlagsSchema.default({}),
});
export type Invocation = z.infer<typeof InvocationSchema>;

/** Where an invocation came from — drives defaults (scope, visibility) and principal policy. */
export const OriginSchema = z.object({
  entry: z.enum([
    'slash',
    'mention',
    'agent-dm',
    'message-shortcut',
    'global-shortcut',
    'modal',
    'reaction',
    'keyword',
    'schedule',
    'workflow',
    'button',
  ]),
  teamId: z.string(),
  /** The human who caused this run. For automations: the automation owner. */
  userId: UserId,
  channelId: z.string().optional(),
  threadTs: z.string().optional(),
  messageTs: z.string().optional(),
  /** Ephemeral reply hook for slash commands / shortcuts. Opaque; never logged. */
  responseUrl: z.string().url().optional(),
  triggerId: z.string().optional(),
  automationId: z.string().optional(),
  /** Channel is shared with external orgs (Slack Connect). */
  externallyShared: z.boolean().optional(),
});
export type Origin = z.infer<typeof OriginSchema>;

export function isUnattended(origin: Origin): boolean {
  return (
    origin.entry === 'schedule' ||
    origin.entry === 'workflow' ||
    origin.entry === 'reaction' ||
    origin.entry === 'keyword'
  );
}
