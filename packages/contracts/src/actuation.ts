import { z } from 'zod';
import { WriteProvenanceSchema } from './provenance.js';

/**
 * Slack write kinds — the host-native mutations the Slack bridge can perform (ge-msft ADR-0007).
 * Each has a defined inverse, or is honestly `not-reversible`.
 */
export const ActuationKindSchema = z.enum([
  'reply',
  'post',
  'canvas',
  'canvas-edit',
  'schedule',
  'remind',
  'bookmark',
  'react',
  'action-items',
  'connector-action',
]);
export type ActuationKind = z.infer<typeof ActuationKindSchema>;

const Channel = z.string().regex(/^[CGD][A-Z0-9]{2,}$/);
const Ts = z.string().regex(/^\d{6,}\.\d{1,8}$/);
const Text = z.string().min(1).max(4000);

export const ActuationParamsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), channel: Channel, threadTs: Ts, text: Text }),
  z.object({ kind: z.literal('post'), channel: Channel, text: Text }),
  z.object({
    kind: z.literal('canvas'),
    title: z.string().min(1).max(150),
    markdown: z.string().min(1).max(100_000),
    /** Conversation the canvas is shared to (read access) and announced in. */
    shareTo: Channel.optional(),
  }),
  z.object({
    kind: z.literal('canvas-edit'),
    canvasId: z.string().min(1),
    markdown: z.string().min(1).max(100_000),
    sectionId: z.string().optional(),
    /** Target the one section whose header contains this text (resolved by the bridge). */
    heading: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('schedule'),
    channel: Channel,
    /** Unix seconds. Must be in the future and within Slack's 120-day limit. */
    postAt: z.number().int().positive(),
    text: Text,
  }),
  z.object({
    kind: z.literal('remind'),
    user: z.string().regex(/^[UW][A-Z0-9]{2,}$/),
    postAt: z.number().int().positive(),
    text: Text,
  }),
  z.object({
    kind: z.literal('bookmark'),
    channel: Channel,
    title: z.string().min(1).max(150),
    link: z.string().url(),
  }),
  z.object({
    kind: z.literal('react'),
    channel: Channel,
    ts: Ts,
    emoji: z.string().regex(/^[a-z0-9_+'-]{1,80}$/),
  }),
  z.object({
    /** Owned action items → a Slack List (paid plans) or, failing that, a checklist reply. */
    kind: z.literal('action-items'),
    title: z.string().min(1).max(150),
    items: z
      .array(
        z.object({
          text: z.string().min(1).max(500),
          owner: z
            .string()
            .regex(/^[UW][A-Z0-9]{2,}$/)
            .optional(),
          due: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
      )
      .min(1)
      .max(50),
    /** Conversation the list is shared to and where the fallback checklist lands. */
    channel: Channel,
    threadTs: Ts.optional(),
  }),
  z.object({
    /** A Gemini Enterprise connector tool call (MCP `tools/call`), run as the approver. */
    kind: z.literal('connector-action'),
    connector: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    collection: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    tool: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** Human summary shown on the card (escaped at render). */
    summary: z.string().min(1).max(300),
    arguments: z.record(z.unknown()),
  }),
]);
export type ActuationParams = z.infer<typeof ActuationParamsSchema>;

export const ActuationRequestSchema = z.object({
  /** Client-minted correlation id. Correlates; does not guarantee dedupe on Slack. */
  changeId: z.string().min(8),
  params: ActuationParamsSchema,
  provenance: WriteProvenanceSchema.optional(),
});
export type ActuationRequest = z.infer<typeof ActuationRequestSchema>;

export const InverseSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('delete-message'), channel: z.string(), ts: z.string() }),
  z.object({ op: z.literal('delete-canvas'), canvasId: z.string() }),
  z.object({
    op: z.literal('delete-scheduled'),
    channel: z.string(),
    scheduledMessageId: z.string(),
    postAt: z.number(),
  }),
  z.object({ op: z.literal('remove-bookmark'), channel: z.string(), bookmarkId: z.string() }),
  z.object({
    op: z.literal('remove-reaction'),
    channel: z.string(),
    ts: z.string(),
    emoji: z.string(),
  }),
  z.object({
    op: z.literal('delete-list-items'),
    listId: z.string(),
    itemIds: z.array(z.string()).min(1),
    /** The thread message announcing the list, deleted with it. */
    announcement: z.object({ channel: z.string(), ts: z.string() }).optional(),
  }),
  z.object({ op: z.literal('not-reversible'), reason: z.string() }),
]);
export type Inverse = z.infer<typeof InverseSchema>;

export const ActuationOutcomeSchema = z.enum(['applied', 'uncertain', 'failed', 'rejected']);
export type ActuationOutcome = z.infer<typeof ActuationOutcomeSchema>;

export const ActuationResultSchema = z.object({
  changeId: z.string(),
  kind: ActuationKindSchema,
  outcome: ActuationOutcomeSchema,
  location: z
    .object({
      channel: z.string().optional(),
      ts: z.string().optional(),
      canvasId: z.string().optional(),
      listId: z.string().optional(),
      permalink: z.string().optional(),
    })
    .optional(),
  inverse: InverseSchema.optional(),
  /** Was durable provenance actually attached (message metadata)? Never assumed. */
  provenancePersisted: z.boolean(),
  /** Applied differently than planned, said plainly (e.g. "Lists unavailable — posted as a checklist"). */
  note: z.string().max(300).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ActuationResult = z.infer<typeof ActuationResultSchema>;

/**
 * Approval classes (ge-msft `plan-graph`): `in-conversation` stays where the request was made;
 * `external` lands somewhere else (another channel, the future, a canvas others can open);
 * `personal` targets a specific person's DM.
 */
export type ApprovalClass = 'in-conversation' | 'external' | 'personal';

export function approvalClassOf(p: ActuationParams, originChannel?: string): ApprovalClass {
  switch (p.kind) {
    case 'reply':
    case 'react':
    case 'bookmark':
      return p.channel === originChannel ? 'in-conversation' : 'external';
    case 'post':
      return p.channel === originChannel ? 'in-conversation' : 'external';
    case 'remind':
      return 'personal';
    case 'action-items':
      return p.channel === originChannel ? 'in-conversation' : 'external';
    case 'canvas':
    case 'canvas-edit':
    case 'schedule':
    case 'connector-action':
      return 'external';
  }
}

export const KIND_LABELS: Record<ActuationKind, { emoji: string; label: string; undo: string }> = {
  reply: { emoji: '💬', label: 'Reply in thread', undo: 'Undo' },
  post: { emoji: '📣', label: 'Post message', undo: 'Undo' },
  canvas: { emoji: '📄', label: 'Create canvas', undo: 'Undo' },
  'canvas-edit': { emoji: '✏️', label: 'Edit canvas', undo: 'Not reversible' },
  schedule: { emoji: '⏰', label: 'Schedule message', undo: 'Cancel' },
  remind: { emoji: '🔔', label: 'Remind', undo: 'Cancel' },
  bookmark: { emoji: '🔖', label: 'Add bookmark', undo: 'Undo' },
  react: { emoji: '😀', label: 'Add reaction', undo: 'Undo' },
  'action-items': { emoji: '✅', label: 'Add action items', undo: 'Undo' },
  'connector-action': { emoji: '🔌', label: 'Connector action', undo: 'Not reversible' },
};

export interface AutoApplyContext {
  originChannel?: string;
  originThreadTs?: string;
  destination?: string;
  channelAutoApply: boolean;
}

/**
 * The unattended actuation gate (EXPERIENCE §8). Fails closed: only a reply in the triggering
 * thread, or a post to the automation's own configured destination, may auto-apply — and only when
 * the channel policy allows auto-apply at all. Everything else becomes a plan card for the owner.
 */
export function canAutoApply(p: ActuationParams, ctx: AutoApplyContext): boolean {
  if (!ctx.channelAutoApply) return false;
  if (p.kind === 'reply') {
    return p.channel === ctx.originChannel && p.threadTs === ctx.originThreadTs;
  }
  if (p.kind === 'post') {
    return ctx.destination !== undefined && p.channel === ctx.destination;
  }
  return false;
}
