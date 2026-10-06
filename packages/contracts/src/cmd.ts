import { parsePermalink } from './scope.js';
import type { ActuationKind } from './actuation.js';
import { MAX_ACT_ARGS_CHARS, MAX_ACT_ARGS_DEPTH, jsonDepth } from './connectors.js';

/**
 * The model-facing ```cmd algebra for Slack (ge-msft ADR-0004/0008). The executor skill emits
 * exactly one closed ```cmd fence; this parser is authoritative (the skill's Python preflight
 * mirrors it). Expressions are read-only; effect lines terminate computation and become
 * `ActuationRequest`s only after the runtime compiles, previews, and a human approves them.
 *
 *   read thread | read channel [since=24h] | read <permalink> | search "query"
 *   reply "text" | reply <permalink> "text"
 *   finding <permalink> "text" [severity=high|medium|low]
 *   post <#C…> "text"
 *   canvas "Title" """markdown"""
 *   canvas-edit <canvas-id> """markdown""" [section=<id>]
 *   schedule <#C…> <ISO-8601> "text"
 *   remind <@U…> <ISO-8601> "text"
 *   bookmark "Title" <https://…>
 *   react <permalink> :emoji:
 *   done | help
 */

export type MessageRef = { channel: string; ts: string };

export type CmdEffect =
  | {
      kind: 'reply';
      target: 'scope' | MessageRef;
      text: string;
      severity?: 'high' | 'medium' | 'low';
    }
  | { kind: 'post'; channel: string; text: string }
  | { kind: 'canvas'; title: string; markdown: string }
  | {
      kind: 'canvas-edit';
      canvasId: string;
      markdown: string;
      sectionId?: string;
      heading?: string;
    }
  | { kind: 'action-item'; text: string; owner?: string; due?: string }
  | { kind: 'schedule'; channel: string; at: string; text: string }
  | { kind: 'remind'; user: string; at: string; text: string }
  | { kind: 'bookmark'; title: string; link: string }
  | { kind: 'react'; target: MessageRef; emoji: string }
  | {
      kind: 'connector-action';
      connector: string;
      tool: string;
      summary: string;
      arguments: Record<string, unknown>;
    };

export type CmdLine =
  | { verb: 'read'; target: 'thread' | 'channel' | MessageRef; sinceText?: string; line: string }
  | { verb: 'search'; query: string; line: string }
  | { verb: 'done'; line: string }
  | { verb: 'help'; line: string }
  | { verb: 'effect'; effect: CmdEffect; line: string }
  | { verb: 'error'; error: string; line: string };

export const CMD_READ_VERBS = ['read', 'search'] as const;
export const CMD_EFFECT_VERBS = [
  'reply',
  'finding',
  'post',
  'canvas',
  'canvas-edit',
  'schedule',
  'remind',
  'bookmark',
  'react',
  'action',
  'act',
] as const;
export const CMD_CONTROL_VERBS = ['done', 'help'] as const;
export const CMD_VERBS = [...CMD_READ_VERBS, ...CMD_EFFECT_VERBS, ...CMD_CONTROL_VERBS];

/** Which actuation kind each effect verb compiles to. */
export const EFFECT_VERB_TO_KIND: Record<(typeof CMD_EFFECT_VERBS)[number], ActuationKind> = {
  reply: 'reply',
  finding: 'reply',
  post: 'post',
  canvas: 'canvas',
  'canvas-edit': 'canvas-edit',
  schedule: 'schedule',
  remind: 'remind',
  bookmark: 'bookmark',
  react: 'react',
  action: 'action-items',
  act: 'connector-action',
};

export type FenceResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'no-fence' | 'unclosed-fence' | 'multiple-fences' };

/** Extract the single ```<lang> fence. Missing, unclosed, or duplicate fences fail closed. */
export function extractFence(text: string, lang: 'cmd' | 'plan'): FenceResult {
  const open = new RegExp('(^|\\n)```' + lang + '[ \\t]*\\n', 'g');
  const matches = [...text.matchAll(open)];
  if (matches.length === 0) return { ok: false, reason: 'no-fence' };
  if (matches.length > 1) return { ok: false, reason: 'multiple-fences' };
  const m = matches[0]!;
  const start = m.index! + m[0].length;
  const close = text.indexOf('\n```', start - 1);
  if (close < 0) return { ok: false, reason: 'unclosed-fence' };
  return { ok: true, body: text.slice(start, close) };
}

type Tok = { kind: 'str' | 'word' | 'entity'; text: string; key?: string };

/**
 * Split a program body into statements (newline-separated outside of quotes), then tokenize each.
 * Supports "…" with \" \\ \n escapes, """…""" multi-line blocks, <…> Slack entities, k=v props.
 */
export function splitStatements(body: string): { line: string; toks: Tok[] }[] | { error: string } {
  const out: { line: string; toks: Tok[] }[] = [];
  let toks: Tok[] = [];
  let lineStart = 0;
  let i = 0;
  const flush = (end: number) => {
    const line = body.slice(lineStart, end).trim();
    if (toks.length > 0 && !line.startsWith('#')) out.push({ line, toks });
    toks = [];
  };
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '\n') {
      flush(i);
      i++;
      lineStart = i;
      continue;
    }
    // Any non-newline whitespace (incl. U+00A0, \f, \v) separates tokens. Matching the word
    // branch's \s stop condition here guarantees the scanner always advances.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '#' && toks.length === 0) {
      const nl = body.indexOf('\n', i);
      i = nl < 0 ? body.length : nl;
      continue;
    }
    // optional key= prefix
    const keyMatch = /^([a-z][a-z0-9_-]*)=/i.exec(body.slice(i, i + 40));
    let key: string | undefined;
    if (keyMatch) {
      key = keyMatch[1]!.toLowerCase();
      i += keyMatch[0].length;
    }
    if (body.startsWith('"""', i)) {
      const end = body.indexOf('"""', i + 3);
      if (end < 0) return { error: 'unclosed """ block' };
      toks.push({
        kind: 'str',
        text: body.slice(i + 3, end).replace(/^\n/, ''),
        ...(key ? { key } : {}),
      });
      i = end + 3;
      continue;
    }
    if (body[i] === '"') {
      let j = i + 1;
      let s = '';
      for (; j < body.length; j++) {
        const c = body[j]!;
        if (c === '\\' && j + 1 < body.length) {
          const n = body[j + 1]!;
          s += n === 'n' ? '\n' : n;
          j++;
          continue;
        }
        if (c === '"') break;
        if (c === '\n') return { error: 'unclosed "string" (use """ for multi-line text)' };
        s += c;
      }
      if (j >= body.length) return { error: 'unclosed "string"' };
      toks.push({ kind: 'str', text: s, ...(key ? { key } : {}) });
      i = j + 1;
      continue;
    }
    if (body[i] === '<') {
      const end = body.indexOf('>', i);
      if (end > i) {
        toks.push({ kind: 'entity', text: body.slice(i, end + 1), ...(key ? { key } : {}) });
        i = end + 1;
        continue;
      }
    }
    let j = i;
    while (j < body.length && !/\s/.test(body[j]!)) j++;
    toks.push({ kind: 'word', text: body.slice(i, j), ...(key ? { key } : {}) });
    i = j;
  }
  flush(body.length);
  return out;
}

function messageRef(t: Tok | undefined): MessageRef | undefined {
  if (!t) return undefined;
  const raw = t.kind === 'entity' ? t.text.slice(1, -1).split('|')[0]! : t.text;
  const p = parsePermalink(raw);
  return p ? { channel: p.channel, ts: p.ts } : undefined;
}

function channelRef(t: Tok | undefined): string | undefined {
  if (!t) return undefined;
  const ent = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(t.text);
  if (ent) return ent[1];
  return /^[CGD][A-Z0-9]{2,}$/.test(t.text) ? t.text : undefined;
}

function userRef(t: Tok | undefined): string | undefined {
  if (!t) return undefined;
  const ent = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(t.text);
  if (ent) return ent[1];
  return /^[UW][A-Z0-9]{2,}$/.test(t.text) ? t.text : undefined;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function str(toks: Tok[], idx: number): string | undefined {
  const t = toks[idx];
  return t && t.kind === 'str' && !t.key ? t.text : undefined;
}

function prop(toks: Tok[], key: string): string | undefined {
  return toks.find((t) => t.key === key)?.text;
}

export function parseStatement(line: string, toks: Tok[]): CmdLine {
  const head = toks[0]!;
  const verb = head.text.toLowerCase();
  const args = toks.slice(1);
  const positional = args.filter((t) => !t.key);
  const err = (error: string): CmdLine => ({ verb: 'error', error, line });

  switch (verb) {
    case 'done':
      return { verb: 'done', line };
    case 'help':
      return { verb: 'help', line };
    case 'read': {
      const a = positional[0];
      if (!a)
        return err(
          'read needs a target: read thread | read channel [since=24h] | read <permalink>',
        );
      if (a.kind === 'word' && (a.text === 'thread' || a.text === 'channel')) {
        const since = prop(args, 'since');
        return { verb: 'read', target: a.text, ...(since ? { sinceText: since } : {}), line };
      }
      const ref = messageRef(a);
      if (!ref) return err(`read: "${a.text}" is not thread, channel, or a Slack message link`);
      return { verb: 'read', target: ref, line };
    }
    case 'search': {
      const q = str(positional, 0);
      if (!q) return err('search needs a "quoted query"');
      return { verb: 'search', query: q, line };
    }
    case 'reply': {
      const first = positional[0];
      if (first?.kind === 'str')
        return {
          verb: 'effect',
          effect: { kind: 'reply', target: 'scope', text: first.text },
          line,
        };
      const ref = messageRef(first);
      const text = str(positional, 1);
      if (!ref || !text) return err('reply "text" | reply <permalink> "text"');
      return { verb: 'effect', effect: { kind: 'reply', target: ref, text }, line };
    }
    case 'finding': {
      const ref = messageRef(positional[0]);
      const text = str(positional, 1);
      if (!ref || !text) return err('finding <permalink> "text" [severity=high|medium|low]');
      const sev = prop(args, 'severity')?.toLowerCase();
      if (sev && sev !== 'high' && sev !== 'medium' && sev !== 'low') {
        return err('finding severity must be high, medium or low');
      }
      return {
        verb: 'effect',
        effect: {
          kind: 'reply',
          target: ref,
          text,
          ...(sev ? { severity: sev as 'high' | 'medium' | 'low' } : {}),
        },
        line,
      };
    }
    case 'post': {
      const channel = channelRef(positional[0]);
      const text = str(positional, 1);
      if (!channel || !text) return err('post <#channel> "text"');
      return { verb: 'effect', effect: { kind: 'post', channel, text }, line };
    }
    case 'canvas': {
      const title = str(positional, 0);
      const markdown = str(positional, 1);
      if (!title || !markdown) return err('canvas "Title" """markdown"""');
      return { verb: 'effect', effect: { kind: 'canvas', title, markdown }, line };
    }
    case 'canvas-edit': {
      const id = positional[0];
      const markdown = str(positional, 1);
      const usage = 'canvas-edit <canvas-id> """markdown""" [section=<id> | heading="text"]';
      if (!id || id.kind !== 'word' || !markdown) return err(usage);
      const sectionId = prop(args, 'section');
      const heading = prop(args, 'heading');
      if (sectionId && heading) return err('canvas-edit takes section= or heading=, not both');
      return {
        verb: 'effect',
        effect: {
          kind: 'canvas-edit',
          canvasId: id.text,
          markdown,
          ...(sectionId ? { sectionId } : {}),
          ...(heading ? { heading } : {}),
        },
        line,
      };
    }
    case 'action': {
      // action <@owner> "text" [due=YYYY-MM-DD]  |  action "text" [due=…]
      const owner = userRef(positional[0]);
      const text = owner ? str(positional, 1) : str(positional, 0);
      if (!text) return err('action <@person> "item" [due=YYYY-MM-DD]');
      const due = prop(args, 'due');
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due))
        return err(`action: due "${due}" must be YYYY-MM-DD`);
      return {
        verb: 'effect',
        effect: { kind: 'action-item', text, ...(owner ? { owner } : {}), ...(due ? { due } : {}) },
        line,
      };
    }
    case 'schedule': {
      const channel = channelRef(positional[0]);
      const at = positional[1]?.text;
      const text = str(positional, 2);
      if (!channel || !at || !text) return err('schedule <#channel> <ISO-8601> "text"');
      if (!ISO.test(at))
        return err(
          `schedule: "${at}" is not an ISO-8601 time with an offset (e.g. 2026-10-12T09:00:00-07:00)`,
        );
      return { verb: 'effect', effect: { kind: 'schedule', channel, at, text }, line };
    }
    case 'remind': {
      const user = userRef(positional[0]);
      const at = positional[1]?.text;
      const text = str(positional, 2);
      if (!user || !at || !text) return err('remind <@person> <ISO-8601> "text"');
      if (!ISO.test(at)) return err(`remind: "${at}" is not an ISO-8601 time with an offset`);
      return { verb: 'effect', effect: { kind: 'remind', user, at, text }, line };
    }
    case 'bookmark': {
      const title = str(positional, 0);
      const linkTok = positional[1];
      const link =
        linkTok?.kind === 'entity' ? linkTok.text.slice(1, -1).split('|')[0] : linkTok?.text;
      if (!title || !link || !/^https:\/\//.test(link)) return err('bookmark "Title" <https://…>');
      return { verb: 'effect', effect: { kind: 'bookmark', title, link }, line };
    }
    case 'react': {
      const ref = messageRef(positional[0]);
      const emoji = /^:([a-z0-9_+'-]{1,80}):$/.exec(positional[1]?.text ?? '')?.[1];
      if (!ref || !emoji) return err('react <permalink> :emoji:');
      return { verb: 'effect', effect: { kind: 'react', target: ref, emoji }, line };
    }
    case 'act': {
      // act <connector>.<tool> "summary" """{json arguments}"""
      const usage = 'act <connector>.<tool> "summary" """{json arguments}"""';
      const target = positional[0];
      const m =
        target?.kind === 'word'
          ? /^@?([a-z0-9][a-z0-9_-]{0,62})\.([A-Za-z0-9_-]{1,64})$/.exec(target.text)
          : null;
      const summary = str(positional, 1);
      const raw = str(positional, 2);
      if (!m || !summary || raw === undefined) return err(usage);
      if (raw.length > MAX_ACT_ARGS_CHARS) {
        return err(`act: arguments are limited to ${MAX_ACT_ARGS_CHARS} characters`);
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(raw);
      } catch {
        return err('act: arguments must be a JSON object');
      }
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        return err('act: arguments must be a JSON object');
      }
      if (jsonDepth(parsedArgs) > MAX_ACT_ARGS_DEPTH) {
        return err(`act: arguments are nested more than ${MAX_ACT_ARGS_DEPTH} levels`);
      }
      return {
        verb: 'effect',
        effect: {
          kind: 'connector-action',
          connector: m[1]!,
          tool: m[2]!,
          summary,
          arguments: parsedArgs as Record<string, unknown>,
        },
        line,
      };
    }
    default: {
      const guess = closest(verb, CMD_VERBS);
      return err(`unknown verb "${verb}"${guess ? ` — did you mean "${guess}"?` : ''}`);
    }
  }
}

export interface ParsedProgram {
  lines: CmdLine[];
  errors: string[];
  done: boolean;
}

/** Parse a whole model response: exactly one ```cmd fence, every statement parsed. */
export function parseProgram(response: string): ParsedProgram | { fenceError: FenceResult } {
  const fence = extractFence(response, 'cmd');
  if (!fence.ok) return { fenceError: fence };
  const stmts = splitStatements(fence.body);
  if ('error' in stmts) return { lines: [], errors: [stmts.error], done: false };
  const lines = stmts.map((s) => parseStatement(s.line, s.toks));
  const errors = lines.flatMap((l) => (l.verb === 'error' ? [`${l.line}: ${l.error}`] : []));
  return { lines, errors, done: lines.some((l) => l.verb === 'done') };
}

function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const o of options) {
    const d = levenshtein(word, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** The per-turn capability signature injected into the executor prompt (ADR-0008 §1). */
export function renderCmdSignature(kinds: readonly ActuationKind[]): string {
  const usage: Record<string, string> = {
    reply:
      'reply "text" | reply <permalink> "text"   (also: finding <permalink> "text" [severity=…])',
    post: 'post <#channel> "text"',
    canvas: 'canvas "Title" """markdown"""',
    'canvas-edit': 'canvas-edit <canvas-id> """markdown""" [section=<id> | heading="text"]',
    'action-items':
      'action <@person> "item" [due=YYYY-MM-DD]   (one line per item; together they become one list)',
    schedule: 'schedule <#channel> <ISO-8601 with offset> "text"',
    remind: 'remind <@person> <ISO-8601 with offset> "text"',
    bookmark: 'bookmark "Title" <https://…>',
    react: 'react <permalink> :emoji:',
    'connector-action':
      'act <connector>.<tool> "what this does, in one line" """{json arguments}"""   (only the tools listed under connector tools)',
  };
  return [
    'reads:   read thread | read channel [since=24h] | read <permalink> | search "query"',
    ...kinds.map((k) => `effect:  ${usage[k]}`),
    'control: done | help',
  ].join('\n');
}
