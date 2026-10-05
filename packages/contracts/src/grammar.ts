import {
  ControlVerbSchema,
  INTENT_ALIASES,
  IntentSchema,
  type ControlVerb,
  type Intent,
} from './intent.js';
import { parseDuration, parsePermalink, type Scope } from './scope.js';
import type { Ground } from './ground.js';
import { InvocationSchema, type Invocation, type InvocationFlags } from './invocation.js';
import type { Trigger } from './automation.js';
import { scheduleTextToCron } from './schedule-text.js';

/**
 * The user-facing grammar — one parser for every text entry point (slash command text, app mention
 * text with the bot mention stripped, agent DM, modal preview). It expects Slack's escaped form
 * (`<#C123|name>`, `<@U123>`, `<https://…>`), which the manifest enables with `should_escape`.
 *
 *   /gemini <verb> [scope…] [@ground…] [<@person>…] [--flag value…] [instruction…]
 *   /gemini automate "<schedule>" <verb> …   |   /gemini automate on :emoji: <verb> …
 *   /gemini automate on /regex/ <verb> …
 *
 * Unknown first words are not errors: the whole text becomes an `ask` (inferredVerb), matching
 * ge-msft where free text routes through the planner.
 */
export type ParsedCommand =
  | { kind: 'compose' }
  | { kind: 'invoke'; invocation: Invocation; warnings: string[] }
  | { kind: 'control'; verb: ControlVerb; args: string[] }
  | { kind: 'automate'; trigger: Trigger; invocation: Invocation; warnings: string[] }
  | { kind: 'error'; message: string; hint?: string };

type Token = { text: string; quoted: boolean };

const SMART_QUOTES: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'" };

/** Split on whitespace, keeping "quoted strings" and <slack entities> whole. */
export function tokenize(raw: string): Token[] {
  const s = raw.replace(/[“”‘’]/g, (c) => SMART_QUOTES[c] ?? c);
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      if (end > i) {
        out.push({ text: s.slice(i + 1, end), quoted: true });
        i = end + 1;
        continue;
      }
    }
    if (ch === '<') {
      const end = s.indexOf('>', i + 1);
      if (end > i) {
        out.push({ text: s.slice(i, end + 1), quoted: false });
        i = end + 1;
        continue;
      }
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    out.push({ text: s.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

const CHANNEL_ENTITY = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/;
const USER_ENTITY = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const LINK_ENTITY = /^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/;
const GROUND_TOKEN = /^@([a-z0-9][a-z0-9_.-]{0,62})$/i;
const SCOPE_TOKEN = /^scope:(thread|channel|dm|message|canvas|search)(?:\((.*)\))?$/i;

export function channelFromEntity(text: string): string | undefined {
  return CHANNEL_ENTITY.exec(text)?.[1];
}

export function userFromEntity(text: string): string | undefined {
  return USER_ENTITY.exec(text)?.[1];
}

function resolveVerb(word: string): Intent | ControlVerb | 'automate' | undefined {
  const w = word.replace(/^\//, '').toLowerCase();
  if (w === 'automate' || w === 'schedule') return 'automate';
  const intent = IntentSchema.safeParse(w);
  if (intent.success) return intent.data;
  const control = ControlVerbSchema.safeParse(w);
  if (control.success) return control.data;
  return INTENT_ALIASES[w];
}

function isIntent(v: string): v is Intent {
  return IntentSchema.safeParse(v).success;
}

/** Parse the full text of a command. */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text) return { kind: 'compose' };
  const tokens = tokenize(text);
  const first = tokens[0]!;
  const verb = first.quoted ? undefined : resolveVerb(first.text);

  if (verb === 'automate') return parseAutomate(tokens.slice(1));
  if (verb && !isIntent(verb)) {
    return { kind: 'control', verb, args: tokens.slice(1).map((t) => t.text) };
  }
  if (verb) return finishInvoke(verb, false, tokens.slice(1));
  return finishInvoke('ask', true, tokens);
}

function finishInvoke(verb: Intent, inferred: boolean, rest: Token[]): ParsedCommand {
  const r = parseInvocationTokens(verb, inferred, rest);
  if ('error' in r) return { kind: 'error', message: r.error, ...(r.hint ? { hint: r.hint } : {}) };
  return { kind: 'invoke', invocation: r.invocation, warnings: r.warnings };
}

type InvocationParse =
  { invocation: Invocation; warnings: string[] } | { error: string; hint?: string };

const FLAG_WITH_VALUE = new Set(['since', 'to', 'as', 'tone']);

export function parseInvocationTokens(
  verb: Intent,
  inferredVerb: boolean,
  tokens: Token[],
): InvocationParse {
  let scope: Scope | undefined;
  const grounds: Ground[] = [];
  const people: string[] = [];
  const from: string[] = [];
  const words: string[] = [];
  const flags: InvocationFlags = {};
  const warnings: string[] = [];

  const setScope = (s: Scope): string | undefined => {
    if (scope && JSON.stringify(scope) !== JSON.stringify(s)) {
      return 'only one scope per command — split it into two commands';
    }
    scope = s;
    return undefined;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const t = tok.text;
    if (tok.quoted) {
      words.push(t);
      continue;
    }

    // --flag value | --flag=value | --bool
    if (t.startsWith('--') && t.length > 2) {
      const [name, inline] = t.slice(2).split('=', 2) as [string, string | undefined];
      const key = name.toLowerCase();
      let value = inline;
      if (value === undefined && FLAG_WITH_VALUE.has(key)) {
        const next = tokens[i + 1];
        if (!next) return { error: `--${key} needs a value` };
        value = next.text;
        i++;
      }
      switch (key) {
        case 'since': {
          const ms = parseDuration(value ?? '');
          if (!ms) return { error: `--since expects a window like 24h, 7d or 2w (got "${value}")` };
          flags.sinceMs = ms;
          break;
        }
        case 'to': {
          const ch = channelFromEntity(value ?? '');
          if (!ch) return { error: '--to expects a #channel', hint: 'e.g. --to #eng-digest' };
          flags.to = ch;
          break;
        }
        case 'as': {
          const v = (value ?? '').toLowerCase();
          if (v !== 'me' && v !== 'service') return { error: '--as expects "me" or "service"' };
          flags.as = v;
          break;
        }
        case 'tone': {
          const v = (value ?? '').toLowerCase();
          if (v !== 'formal' && v !== 'friendly' && v !== 'brief' && v !== 'neutral') {
            return { error: '--tone expects formal, friendly, brief or neutral' };
          }
          flags.tone = v;
          break;
        }
        case 'public':
          flags.visibility = 'public';
          break;
        case 'private':
          flags.visibility = 'private';
          break;
        case 'dry-run':
        case 'dryrun':
          flags.dryRun = true;
          break;
        default:
          return {
            error: `unknown flag --${key}`,
            hint: 'flags: --since --to --as --tone --public --private --dry-run',
          };
      }
      continue;
    }

    const scopeTok = SCOPE_TOKEN.exec(t);
    if (scopeTok) {
      const kind = scopeTok[1]!.toLowerCase();
      const arg = scopeTok[2]?.trim().replace(/^["']|["']$/g, '');
      let s: Scope | undefined;
      if (kind === 'thread') s = { kind: 'thread' };
      else if (kind === 'channel') s = { kind: 'channel' };
      else if (kind === 'dm') s = { kind: 'dm' };
      else if (kind === 'canvas') {
        if (!arg) return { error: 'scope:canvas(<id>) needs a canvas id' };
        s = { kind: 'canvas', id: arg };
      } else if (kind === 'search') {
        if (!arg) return { error: 'scope:search("query") needs a query' };
        s = { kind: 'search', query: arg };
      } else {
        const link = parsePermalink((arg ?? '').replace(/^<|>$/g, '').split('|')[0] ?? '');
        if (!link) return { error: 'scope:message(<permalink>) needs a Slack message link' };
        s = { kind: 'message', channel: link.channel, ts: link.ts };
      }
      const err = setScope(s);
      if (err) return { error: err };
      continue;
    }

    const channel = channelFromEntity(t);
    if (channel) {
      const err = setScope({ kind: 'channel', channel });
      if (err) return { error: err, hint: 'use --to #channel for a destination' };
      continue;
    }

    if (t.toLowerCase().startsWith('from:')) {
      const u = userFromEntity(t.slice(5));
      if (!u) return { error: 'from: expects a @person' };
      from.push(u);
      continue;
    }

    const user = userFromEntity(t);
    if (user) {
      people.push(user);
      continue;
    }

    const link = LINK_ENTITY.exec(t);
    if (link) {
      const pl = parsePermalink(link[1]!);
      if (pl) {
        const err = setScope({ kind: 'message', channel: pl.channel, ts: pl.ts });
        if (err) return { error: err };
        continue;
      }
      words.push(link[1]!);
      continue;
    }

    const ground = GROUND_TOKEN.exec(t);
    if (ground) {
      const name = ground[1]!.toLowerCase();
      const g: Ground =
        name === 'unit' || name === 'this' || name === 'web'
          ? { kind: name }
          : { kind: 'alias', alias: name };
      if (!grounds.some((x) => JSON.stringify(x) === JSON.stringify(g))) grounds.push(g);
      continue;
    }

    // Bare scope words directly after the verb read naturally: "summarize this thread".
    const next = tokens[i + 1];
    const article =
      /^(this|the)$/i.test(t) && next && !next.quoted && /^(thread|channel)$/i.test(next.text);
    if (words.length === 0 && !inferredVerb && (article || /^(thread|channel)$/i.test(t))) {
      const word = article ? next!.text : t;
      if (article) i++;
      const err = setScope({ kind: word.toLowerCase() as 'thread' | 'channel' });
      if (err) return { error: err };
      continue;
    }

    words.push(t);
  }

  if (grounds.some((g) => g.kind === 'this') && grounds.length > 1) {
    warnings.push('@this means "only the scope" — other sources were ignored');
  }

  const parsed = InvocationSchema.safeParse({
    verb,
    inferredVerb,
    ...(scope ? { scope } : {}),
    grounds: grounds.some((g) => g.kind === 'this') ? [{ kind: 'this' }] : grounds,
    people,
    from,
    instruction: words.join(' ').trim(),
    flags,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid command' };
  }
  return { invocation: parsed.data, warnings };
}

function parseAutomate(tokens: Token[]): ParsedCommand {
  const usage =
    'automate "weekdays 9:00" summarize #eng --to #eng-digest · automate on :memo: notes · automate on /incident/ ask @runbooks';
  const head = tokens[0];
  if (!head) return { kind: 'error', message: 'automate needs a trigger', hint: usage };

  let trigger: Trigger;
  let rest: Token[];
  if (head.quoted) {
    const cron = scheduleTextToCron(head.text);
    if (!cron.ok) return { kind: 'error', message: cron.error, hint: usage };
    trigger = { kind: 'schedule', text: head.text, cron: cron.cron, timeZone: 'UTC' };
    rest = tokens.slice(1);
  } else if (head.text.toLowerCase() === 'on' && tokens[1]) {
    const t = tokens[1].text;
    const emoji = /^:([a-z0-9_+'-]{1,80}):$/.exec(t);
    const regex = /^\/(.{1,200})\/$/.exec(t);
    if (emoji) {
      trigger = { kind: 'reaction', emoji: emoji[1]! };
    } else if (regex) {
      const pattern = regex[1]!;
      if (!isSafePattern(pattern)) {
        return {
          kind: 'error',
          message: 'that pattern is too complex for a trigger',
          hint: 'use plain words and | alternatives',
        };
      }
      // Channel is bound by the dispatcher from the origin conversation.
      trigger = { kind: 'keyword', pattern, channel: '' };
    } else {
      return {
        kind: 'error',
        message: `automate on expects :emoji: or /pattern/ (got ${t})`,
        hint: usage,
      };
    }
    rest = tokens.slice(2);
  } else {
    return {
      kind: 'error',
      message: 'automate expects a "schedule" or on :emoji: / on /pattern/',
      hint: usage,
    };
  }

  const verbTok = rest[0];
  const verb = verbTok && !verbTok.quoted ? resolveVerb(verbTok.text) : undefined;
  if (!verb || !isIntent(verb)) {
    return {
      kind: 'error',
      message: 'automate needs a verb to run (ask, summarize, notes, draft…)',
      hint: usage,
    };
  }
  const r = parseInvocationTokens(verb, false, rest.slice(1));
  if ('error' in r) return { kind: 'error', message: r.error, ...(r.hint ? { hint: r.hint } : {}) };
  return { kind: 'automate', trigger, invocation: r.invocation, warnings: r.warnings };
}

/**
 * Keyword triggers run on every message in a channel, so the pattern must be cheap: letters,
 * digits, spaces, `|` alternation, `-`, and simple `[12]` classes — no nested quantifiers or
 * backreferences (ReDoS).
 */
export function isSafePattern(pattern: string): boolean {
  if (!/^[\w\s|\-[\]]+$/.test(pattern)) return false;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Render an invocation back to its one-line grammar (the composer's live footer). */
export function renderInvocation(inv: Invocation): string {
  const parts: string[] = [inv.verb];
  const s = inv.scope;
  if (s) {
    if (s.kind === 'channel' && s.channel) parts.push(`<#${s.channel}>`);
    else if (s.kind === 'message') parts.push(`scope:message`);
    else if (s.kind === 'canvas') parts.push(`scope:canvas(${s.id})`);
    else if (s.kind === 'search') parts.push(`scope:search("${s.query}")`);
    else parts.push(`scope:${s.kind}`);
  }
  for (const f of inv.from) parts.push(`from:<@${f}>`);
  for (const g of inv.grounds) parts.push(g.kind === 'alias' ? `@${g.alias}` : `@${g.kind}`);
  for (const p of inv.people) parts.push(`<@${p}>`);
  const f = inv.flags;
  if (f.sinceMs) parts.push(`--since ${formatDuration(f.sinceMs)}`);
  if (f.to) parts.push(`--to <#${f.to}>`);
  if (f.as) parts.push(`--as ${f.as}`);
  if (f.tone) parts.push(`--tone ${f.tone}`);
  if (f.visibility === 'public') parts.push('--public');
  if (f.dryRun) parts.push('--dry-run');
  if (inv.instruction) parts.push(`"${inv.instruction.replace(/"/g, "'")}"`);
  return parts.join(' ');
}

export function formatDuration(ms: number): string {
  const w = 604_800_000;
  const d = 86_400_000;
  if (ms % w === 0) return `${ms / w}w`;
  if (ms % d === 0) return `${ms / d}d`;
  return `${Math.round(ms / 3_600_000)}h`;
}
