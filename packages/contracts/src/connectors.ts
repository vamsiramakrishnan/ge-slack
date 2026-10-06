import { z } from 'zod';

/**
 * Connector actions (EXPERIENCE §10, ADR-0002 §Next): an admin allow-list of Gemini Enterprise
 * connector tools that `draft` may *propose*. Each one runs only after the requester approves the
 * exact call, as the approver, through `dataConnector:invokeConnectorMcp` (`tools/call`).
 */
export const ConnectorToolSchema = z.object({
  /** MCP tool name as the connector lists it (e.g. `create_issue`). */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** May the Gemini service run it? Default false (fail closed). */
  serviceAllowed: z.boolean().default(false),
  /** Admin-written description; preferred over the connector's own (which is untrusted). */
  description: z.string().max(300).optional(),
});

export const ConnectorEntrySchema = z.object({
  /** Used in `act <alias>.<tool>`; no dots. */
  alias: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'aliases are lowercase letters, digits, _ -'),
  title: z.string().min(1).max(60),
  /** The connector's collection id (`…/collections/<id>/dataConnector`). */
  collection: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  tools: z.array(ConnectorToolSchema).min(1).max(20),
});
export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>;

/** A tool the connector offers this person *and* the admin allowed — what the executor may use. */
export interface AvailableConnectorTool {
  alias: string;
  title: string;
  collection: string;
  name: string;
  description?: string;
  /** JSON Schema of the arguments, compacted for the prompt. */
  inputSchema?: string;
}

/**
 * Arguments must fit — whole — on the approval card (Slack section text ≤ 3000 characters), so
 * what a person approves is exactly what runs (security review F1).
 */
export const MAX_ACT_ARGS_CHARS = 2000;
/** Nesting limit for arguments (the Python mirror can't parse arbitrarily deep JSON). */
export const MAX_ACT_ARGS_DEPTH = 16;

export function jsonDepth(v: unknown, d = 0): number {
  if (d > MAX_ACT_ARGS_DEPTH) return d;
  if (Array.isArray(v)) return Math.max(d + 1, ...v.map((x) => jsonDepth(x, d + 1)));
  if (v && typeof v === 'object') {
    return Math.max(d + 1, ...Object.values(v).map((x) => jsonDepth(x, d + 1)));
  }
  return d;
}
