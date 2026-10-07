import { z } from 'zod';

/** A grounding source. `excerpt` is display-only and never persisted (ge-msft Finding 1). */
export const SourceRefSchema = z.object({
  title: z.string(),
  uri: z.string().optional(),
  locator: z.string().optional(),
  excerpt: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Per-answer provenance emitted by the stream (ge-msft `ProvenancePayload`). */
export const AnswerProvenanceSchema = z.object({
  agentId: z.string(),
  identity: z.string(),
  timestamp: z.string(),
  sources: z.array(SourceRefSchema),
  contentHash: z.string(),
  sessionId: z.string().optional(),
});
export type AnswerProvenance = z.infer<typeof AnswerProvenanceSchema>;

/**
 * Durable provenance for a landed Slack write. Serialized into Slack message metadata as
 * `event_type: "ge_provenance"`. Carries source identity only (title/uri) — no excerpts, no tokens.
 */
export const WriteProvenanceSchema = z.object({
  changeId: z.string(),
  agentId: z.string(),
  /** `user:<email>` or `service:<sa-email>`. */
  principal: z.string(),
  /** Slack user who invoked / owns the automation. */
  invoker: z.string(),
  approvedBy: z.string().optional(),
  /** `auto` when an unattended gate applied it under channel policy. */
  /** `trust`: a self-scoped change the person opted in to apply without a click (ADR-0003 §2). */
  approval: z.enum(['human', 'auto', 'trust']),
  edited: z.boolean().default(false),
  timestamp: z.string(),
  contentHash: z.string(),
  sources: z.array(SourceRefSchema.pick({ title: true, uri: true })).max(20),
  automationId: z.string().optional(),
});
export type WriteProvenance = z.infer<typeof WriteProvenanceSchema>;

export const PROVENANCE_EVENT_TYPE = 'ge_provenance';

/**
 * Slack metadata payload values must be flat scalars/arrays of scalars, so sources are encoded as
 * `title<TAB>uri` strings. Bounded to keep metadata well under Slack's limits.
 */
export function toSlackMetadata(p: WriteProvenance): {
  event_type: string;
  event_payload: Record<string, string | boolean | string[]>;
} {
  const payload: Record<string, string | boolean | string[]> = {
    change_id: p.changeId,
    agent_id: p.agentId,
    principal: p.principal,
    invoker: p.invoker,
    approval: p.approval,
    edited: p.edited,
    timestamp: p.timestamp,
    content_hash: p.contentHash,
    sources: p.sources.slice(0, 10).map((s) => `${s.title.slice(0, 120)}\t${s.uri ?? ''}`),
  };
  if (p.approvedBy) payload.approved_by = p.approvedBy;
  if (p.automationId) payload.automation_id = p.automationId;
  return { event_type: PROVENANCE_EVENT_TYPE, event_payload: payload };
}

export function fromSlackMetadata(meta: unknown): WriteProvenance | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as { event_type?: unknown; event_payload?: Record<string, unknown> };
  if (m.event_type !== PROVENANCE_EVENT_TYPE || !m.event_payload) return undefined;
  const e = m.event_payload;
  const sources = Array.isArray(e.sources)
    ? e.sources
        .filter((s): s is string => typeof s === 'string')
        .map((s) => {
          const [title, uri] = s.split('\t');
          return { title: title ?? '', ...(uri ? { uri } : {}) };
        })
    : [];
  const parsed = WriteProvenanceSchema.safeParse({
    changeId: e.change_id,
    agentId: e.agent_id,
    principal: e.principal,
    invoker: e.invoker,
    approvedBy: e.approved_by,
    approval: e.approval,
    edited: e.edited,
    timestamp: e.timestamp,
    contentHash: e.content_hash,
    sources,
    automationId: e.automation_id,
  });
  return parsed.success ? parsed.data : undefined;
}
