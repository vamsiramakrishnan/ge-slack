import type {
  ActuationKind,
  ChannelPolicy,
  GroundSource,
  Intent,
  Invocation,
  Origin,
  Principal,
  ResearchUnit,
} from '@ge-slack/contracts';
import type { ResolvedScope } from './ports.js';

export const DEFAULT_SINCE_MS = 24 * 3_600_000;

/**
 * Fill a scope from the invocation and origin (EXPERIENCE §3 defaults): inside a thread → the
 * thread; a message shortcut → that message; slash/mention in a channel → the channel window;
 * agent DM free text → no Slack capture.
 */
export function resolveScope(inv: Invocation, origin: Origin): ResolvedScope | { error: string } {
  const s = inv.scope;
  const since = inv.flags.sinceMs ?? DEFAULT_SINCE_MS;
  const ch = origin.channelId;
  if (s) {
    switch (s.kind) {
      case 'thread': {
        const channel = s.channel ?? ch;
        const ts = s.ts ?? origin.threadTs ?? origin.messageTs;
        if (!channel || !ts)
          return {
            error: 'There is no thread here — run it inside a thread or pass a message link.',
          };
        return { kind: 'thread', channel, ts };
      }
      case 'channel': {
        const channel = s.channel ?? ch;
        if (!channel) return { error: 'Which channel? Add a #channel.' };
        return { kind: 'channel', channel, sinceMs: since };
      }
      case 'message':
        return { kind: 'message', channel: s.channel, ts: s.ts };
      case 'canvas':
        return { kind: 'canvas', id: s.id, ...(ch ? { channel: ch } : {}) };
      case 'dm':
        if (!ch) return { error: 'scope:dm only works inside a DM.' };
        return { kind: 'dm', channel: ch };
      case 'search':
        if (!ch) return { error: 'scope:search needs a channel to search in.' };
        return { kind: 'channel', channel: ch, sinceMs: since };
    }
  }
  if (origin.entry === 'agent-dm' || origin.entry === 'global-shortcut') return { kind: 'none' };
  if (origin.threadTs && ch) return { kind: 'thread', channel: ch, ts: origin.threadTs };
  if (origin.entry === 'message-shortcut' && ch && origin.messageTs) {
    return { kind: 'message', channel: ch, ts: origin.messageTs };
  }
  if (ch) return { kind: 'channel', channel: ch, sinceMs: since };
  return { kind: 'none' };
}

export function scopeChannel(scope: ResolvedScope): string | undefined {
  return scope.kind === 'none'
    ? undefined
    : scope.kind === 'canvas'
      ? scope.channel
      : scope.channel;
}

export interface GroundResolution {
  dataStores: string[];
  notebookId?: string;
  titles: string[];
  warnings: string[];
}

/**
 * `@` grounds → Discovery Engine data stores. The service principal only keeps sources that are
 * both marked `serviceAllowed` in the catalog *and* allow-listed for this channel (fail closed).
 */
export function resolveGrounds(
  inv: Invocation,
  catalog: GroundSource[],
  unit: ResearchUnit | undefined,
  principal: Principal,
  policy: ChannelPolicy,
): GroundResolution {
  const out: GroundResolution = { dataStores: [], titles: [], warnings: [] };
  const grounds = inv.grounds.length ? inv.grounds : [{ kind: 'unit' as const }];
  if (grounds.some((g) => g.kind === 'this')) return out;
  const aliases: string[] = [];
  for (const g of grounds) {
    if (g.kind === 'unit') {
      aliases.push(...(unit?.aliases ?? []));
      if (unit?.notebookId) out.notebookId = unit.notebookId;
    } else if (g.kind === 'alias') aliases.push(g.alias);
    else if (g.kind === 'web')
      out.warnings.push('@web uses web grounding only if your Gemini Enterprise app enables it.');
  }
  const byAlias = new Map(catalog.map((c) => [c.alias.toLowerCase(), c]));
  const dropped: string[] = [];
  for (const a of [...new Set(aliases.map((x) => x.toLowerCase()))]) {
    const src = byAlias.get(a);
    if (!src) {
      out.warnings.push(
        `Unknown source @${a} — if you meant a person, pick them from Slack's @ menu.`,
      );
      continue;
    }
    if (
      principal.kind === 'service' &&
      !(src.serviceAllowed && policy.serviceGrounds.includes(src.alias))
    ) {
      dropped.push(src.title);
      continue;
    }
    out.dataStores.push(src.dataStore);
    out.titles.push(src.title);
  }
  if (dropped.length) {
    out.warnings.push(`Not available to the Gemini service here: ${dropped.join(', ')}.`);
  }
  if (principal.kind === 'service') delete out.notebookId;
  return out;
}

/** Which write kinds each verb may use (the per-turn capability signature). */
export function kindsFor(verb: Intent, scope: ResolvedScope): ActuationKind[] {
  switch (verb) {
    case 'review':
      return ['reply', 'react'];
    case 'notes':
      return ['reply', 'post', 'canvas', 'remind'];
    case 'rewrite':
      return scope.kind === 'canvas' ? ['canvas-edit', 'reply'] : ['reply', 'post'];
    case 'draft':
      return ['reply', 'post', 'canvas', 'schedule', 'remind', 'bookmark'];
    default:
      return [];
  }
}

const ACTION_WORDS =
  /\b(post|draft|schedule|remind|reply|respond|create|write|send|announce|canvas|bookmark|action items?|follow[- ]ups?|minutes|notes)\b/i;

/** Free text that asks for an action goes through the planner first (ge-msft routing rule). */
export function looksActionable(text: string): boolean {
  return ACTION_WORDS.test(text);
}
