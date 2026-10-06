import { z } from 'zod';

const ChannelId = z.string().regex(/^[CGD][A-Z0-9]{2,}$/, 'expected a Slack conversation id');
const Ts = z.string().regex(/^\d{6,}\.\d{1,8}$/, 'expected a Slack message ts');

/**
 * WHERE a verb applies — first-class and orthogonal to the verb (ge-msft `CommandScope`), with
 * Slack's own nouns. Refs are resolved by the parser or defaulted by the dispatcher from the origin.
 */
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), channel: ChannelId.optional(), ts: Ts.optional() }),
  z.object({ kind: z.literal('channel'), channel: ChannelId.optional() }),
  z.object({ kind: z.literal('message'), channel: ChannelId, ts: Ts }),
  z.object({ kind: z.literal('canvas'), id: z.string().min(1) }),
  z.object({ kind: z.literal('dm') }),
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(500) }),
]);
export type Scope = z.infer<typeof ScopeSchema>;
export type ScopeKind = Scope['kind'];

export const SCOPE_LABELS: Record<ScopeKind, string> = {
  thread: 'This thread',
  channel: 'Channel (recent)',
  message: 'One message',
  canvas: 'Canvas',
  dm: 'This DM',
  search: 'Search results',
};

/** Parse a permalink like https://acme.slack.com/archives/C123/p1700000000123456?thread_ts=… */
export function parsePermalink(
  url: string,
): { channel: string; ts: string; threadTs?: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!/\.slack\.com$/.test(u.hostname)) return undefined;
  const m = /^\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(u.pathname);
  if (!m) return undefined;
  const ts = `${m[2]}.${m[3]}`;
  const threadTs = u.searchParams.get('thread_ts') ?? undefined;
  return {
    channel: m[1]!,
    ts,
    ...(threadTs && Ts.safeParse(threadTs).success ? { threadTs } : {}),
  };
}

const DURATION = /^(\d{1,3})([hdw])$/;
const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
/** Upper bound on any capture window (the capture budget also bounds message count). */
export const MAX_WINDOW_MS = 30 * UNIT_MS.d;

/** `24h`, `7d`, `2w` → milliseconds, capped at 30 days. */
export function parseDuration(text: string): number | undefined {
  const m = DURATION.exec(text.trim().toLowerCase());
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (ms <= 0) return undefined;
  return Math.min(ms, MAX_WINDOW_MS);
}
