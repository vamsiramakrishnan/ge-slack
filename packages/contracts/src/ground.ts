import { z } from 'zod';

/**
 * WHAT a turn is grounded on — the `@` picker (ge-msft `GroundSource`). `unit` is the channel's
 * pinned research unit; `alias` names a Gemini Enterprise data store / connector from the catalog.
 */
export const GroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unit') }),
  z.object({ kind: z.literal('this') }),
  z.object({ kind: z.literal('web') }),
  z.object({
    kind: z.literal('alias'),
    alias: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/i, 'aliases are letters, digits, . _ -'),
  }),
]);
export type Ground = z.infer<typeof GroundSchema>;

export function groundToken(g: Ground): string {
  return g.kind === 'alias' ? `@${g.alias}` : `@${g.kind}`;
}

/** A catalog entry mapping an alias to a Discovery Engine data store resource. */
export const GroundSourceSchema = z.object({
  alias: z.string(),
  title: z.string(),
  dataStore: z
    .string()
    .regex(/^projects\/[^/]+\/locations\/[^/]+\/collections\/[^/]+\/dataStores\/[^/]+$/),
  /** May the service principal ground on this source? Default false (fail closed). */
  serviceAllowed: z.boolean().default(false),
});
export type GroundSource = z.infer<typeof GroundSourceSchema>;

/** A channel's research unit: the default grounding for every verb run there. */
export const ResearchUnitSchema = z.object({
  aliases: z.array(z.string()).max(20),
  notebookId: z.string().optional(),
});
export type ResearchUnit = z.infer<typeof ResearchUnitSchema>;
