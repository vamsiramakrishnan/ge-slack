import { z } from 'zod';

/**
 * Stage-3 features, each switchable per deployment (`GE_FEATURES`) so it can be tried in a sandbox
 * before it is on for everyone. `connector-actions` is opt-in: it writes outside Slack.
 */
export const FeatureSchema = z.enum(['memory', 'analytics', 'jobs', 'diag', 'connector-actions']);
export type Feature = z.infer<typeof FeatureSchema>;

export const DEFAULT_FEATURES: readonly Feature[] = ['memory', 'analytics', 'jobs', 'diag'];

/**
 * `GE_FEATURES`: comma list. `default` expands to `DEFAULT_FEATURES`; `-name` removes one.
 * Unset → the defaults. Unknown names fail (a typo must not silently turn a feature off).
 */
export function parseFeatures(text: string | undefined): Set<Feature> {
  const out = new Set<Feature>();
  const tokens = (text ?? 'default')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tokens) {
    if (t === 'default') {
      for (const f of DEFAULT_FEATURES) out.add(f);
      continue;
    }
    const remove = t.startsWith('-');
    const name = FeatureSchema.safeParse(remove ? t.slice(1) : t.replace(/^\+/, ''));
    if (!name.success) throw new Error(`Unknown feature in GE_FEATURES: ${t}`);
    if (remove) out.delete(name.data);
    else out.add(name.data);
  }
  return out;
}
