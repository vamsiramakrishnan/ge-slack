import { randomUUID } from 'node:crypto';
import {
  ActuationParamsSchema,
  KIND_LABELS,
  MAX_ACT_ARGS_CHARS,
  approvalClassOf,
  type ActuationParams,
  type ApprovalClass,
  type AvailableConnectorTool,
  type CmdEffect,
} from '@ge-slack/contracts';
import type { ResolvedScope } from './ports.js';

export interface CompileContext {
  scope: ResolvedScope;
  originChannel?: string;
  /** Conversations effects may target: origin, scope channel, `--to` destination. */
  allowedChannels: ReadonlySet<string>;
  /** User ids that appeared in the captured context or the invocation. */
  knownUsers: ReadonlySet<string>;
  /** `channel:ts` of messages the model actually saw. */
  knownMessages: ReadonlySet<string>;
  now: Date;
  newChangeId?: () => string;
  /** Connector tools offered to this principal and allow-listed by an admin (EXPERIENCE §10). */
  connectorTools?: ReadonlyArray<AvailableConnectorTool>;
}

export interface CompiledEffect {
  changeId: string;
  params: ActuationParams;
  line: string;
  label: string;
  preview: string;
  approvalClass: ApprovalClass;
  reversible: boolean;
  /** Exact payload shown on the card (connector-action arguments, pretty JSON). */
  detail?: string;
}

export type CompileResult = { ok: true; effect: CompiledEffect } | { ok: false; error: string };

const MAX_FUTURE_S = 120 * 86_400;

/**
 * Model text is posted under our app's name, so it is sanitized before it can land:
 * broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, user groups) are defused, and user
 * mentions are kept only for people who appeared in the turn — the model never pings strangers.
 */
export function sanitizeOutbound(text: string, knownUsers: ReadonlySet<string>): string {
  const WJ = '\u2060'; // word joiner: keeps "@channel" readable but inert
  return (
    text
      .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/g, '')
      .replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, (_m, w: string) => `@${WJ}${w}`)
      .replace(
        /<!subteam\^[A-Z0-9]+(\|([^>]*))?>/gi,
        (_m, _l, label: string | undefined) => label ?? '@group',
      )
      .replace(
        /(^|[^\w])@(channel|here|everyone)\b/gi,
        (_m, pre: string, w: string) => `${pre}@${WJ}${w}`,
      )
      .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) =>
        knownUsers.has(id) ? `<@${id}>` : 'someone',
      )
      // Canvas mention syntax.
      .replace(/!\[\]\(@([UW][A-Z0-9]+)\)/g, (_m, id: string) =>
        knownUsers.has(id) ? `![](@${id})` : 'someone',
      )
      // Links: never let a label disguise its destination (phishing). Show label + real URL.
      .replace(
        /<(https?:\/\/[^|>\s]+)\|([^>]*)>/g,
        (_m, url: string, label: string) => `${label} (${url})`,
      )
      .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
        label === url ? url : `${label} (${url})`,
      )
  );
}

/** Escape Slack mrkdwn control characters in untrusted text embedded in labels. */
export function mrkdwnEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sanitizes a token stream without letting a construct split across chunks slip through: text
 * after an unclosed `<`, `[`, `!` or a trailing `@word` is held back until it completes.
 */
export class StreamSanitizer {
  private raw = '';
  private emitted = 0;
  constructor(private readonly knownUsers: ReadonlySet<string>) {}

  push(chunk: string): string {
    this.raw += chunk;
    const safeEnd = this.safeBoundary();
    const clean = sanitizeOutbound(this.raw.slice(0, safeEnd), this.knownUsers);
    const out = clean.slice(this.emitted);
    this.emitted = clean.length;
    return out;
  }

  /** Everything, sanitized. Call once at the end. */
  finish(): string {
    const clean = sanitizeOutbound(this.raw, this.knownUsers);
    const out = clean.slice(this.emitted);
    this.emitted = clean.length;
    return out;
  }

  get text(): string {
    return sanitizeOutbound(this.raw, this.knownUsers);
  }

  private safeBoundary(): number {
    const s = this.raw;
    let cut = s.length;
    const lt = s.lastIndexOf('<');
    if (lt >= 0 && s.indexOf('>', lt) < 0) cut = Math.min(cut, lt);
    const br = s.lastIndexOf('[');
    if (br >= 0 && !/\]\([^)]*\)/.test(s.slice(br)) && s.length - br < 600) cut = Math.min(cut, br);
    const bang = s.lastIndexOf('![');
    if (bang >= 0 && s.indexOf(')', bang) < 0) cut = Math.min(cut, bang);
    const at = /@\w*$/.exec(s);
    if (at) cut = Math.min(cut, at.index);
    // Keep the sanitized prefix stable: only cut at whitespace so replacements don't shift.
    const ws = s.lastIndexOf(' ', cut - 1);
    return cut === s.length ? cut : Math.max(0, ws + 1);
  }
}

/** Pretty, bounded JSON for the card (the full arguments are what runs). */
export function prettyArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args, null, 2);
  return s.length > 2500 ? `${s.slice(0, 2499)}…` : s;
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 140 ? `${one.slice(0, 139)}…` : one;
}

function at(iso: string, now: Date): number | string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return `"${iso}" is not a valid time`;
  const s = Math.floor(ms / 1000);
  const nowS = Math.floor(now.getTime() / 1000);
  if (s < nowS + 60) return `${iso} is in the past or less than a minute away`;
  if (s > nowS + MAX_FUTURE_S) return `${iso} is more than 120 days away (Slack's limit)`;
  return s;
}

/** Compile one parsed effect into a validated `ActuationParams`, or a self-correcting error. */
export function compileEffect(effect: CmdEffect, line: string, ctx: CompileContext): CompileResult {
  const err = (error: string): CompileResult => ({ ok: false, error: `${line}: ${error}` });
  const channelOk = (c: string) => ctx.allowedChannels.has(c);
  const msgOk = (c: string, ts: string) => ctx.knownMessages.has(`${c}:${ts}`);
  const clean = (t: string) => sanitizeOutbound(t, ctx.knownUsers);
  let params: ActuationParams;

  switch (effect.kind) {
    case 'reply': {
      if (effect.target === 'scope') {
        const s = ctx.scope;
        if (s.kind === 'thread')
          params = { kind: 'reply', channel: s.channel, threadTs: s.ts, text: clean(effect.text) };
        else if (s.kind === 'message')
          params = { kind: 'reply', channel: s.channel, threadTs: s.ts, text: clean(effect.text) };
        else if ((s.kind === 'channel' || s.kind === 'dm') && channelOk(s.channel)) {
          params = { kind: 'post', channel: s.channel, text: clean(effect.text) };
        } else if (ctx.originChannel && channelOk(ctx.originChannel)) {
          params = { kind: 'post', channel: ctx.originChannel, text: clean(effect.text) };
        } else return err('there is no thread to reply to here; use post <#channel> "…"');
      } else {
        if (!msgOk(effect.target.channel, effect.target.ts)) {
          return err('that permalink is not a message from the captured context');
        }
        if (!channelOk(effect.target.channel)) {
          return err(`<#${effect.target.channel}> is not a conversation named in this request`);
        }
        const sev = effect.severity ? ` · ${effect.severity}` : '';
        const body =
          effect.severity !== undefined || line.trimStart().startsWith('finding')
            ? `🔎 *Finding${sev}*\n${effect.text}`
            : effect.text;
        params = {
          kind: 'reply',
          channel: effect.target.channel,
          threadTs: effect.target.ts,
          text: clean(body),
        };
      }
      break;
    }
    case 'post':
      if (!channelOk(effect.channel))
        return err(`<#${effect.channel}> is not a conversation named in this request (use --to)`);
      params = { kind: 'post', channel: effect.channel, text: clean(effect.text) };
      break;
    case 'canvas':
      params = {
        kind: 'canvas',
        title: clean(effect.title).slice(0, 150),
        markdown: clean(effect.markdown),
        ...(ctx.originChannel && channelOk(ctx.originChannel)
          ? { shareTo: ctx.originChannel }
          : {}),
      };
      break;
    case 'canvas-edit':
      if (ctx.scope.kind !== 'canvas' || ctx.scope.id !== effect.canvasId) {
        return err('canvas-edit may only target the canvas in scope');
      }
      params = {
        kind: 'canvas-edit',
        canvasId: effect.canvasId,
        markdown: clean(effect.markdown),
        ...(effect.sectionId ? { sectionId: effect.sectionId } : {}),
        ...(effect.heading ? { heading: effect.heading } : {}),
      };
      break;
    case 'action-item':
      // Single items are aggregated by compileActionItems(); never compiled alone.
      return err('internal: action items are compiled together');
    case 'schedule': {
      if (!channelOk(effect.channel))
        return err(`<#${effect.channel}> is not a conversation named in this request`);
      const postAt = at(effect.at, ctx.now);
      if (typeof postAt === 'string') return err(postAt);
      params = { kind: 'schedule', channel: effect.channel, postAt, text: clean(effect.text) };
      break;
    }
    case 'remind': {
      if (!ctx.knownUsers.has(effect.user))
        return err(`<@${effect.user}> did not appear in this conversation`);
      const postAt = at(effect.at, ctx.now);
      if (typeof postAt === 'string') return err(postAt);
      params = { kind: 'remind', user: effect.user, postAt, text: clean(effect.text) };
      break;
    }
    case 'bookmark': {
      const channel = ctx.originChannel;
      if (!channel || !channelOk(channel)) return err('bookmarks need a channel');
      params = {
        kind: 'bookmark',
        channel,
        title: clean(effect.title).slice(0, 150),
        link: effect.link,
      };
      break;
    }
    case 'connector-action': {
      // Only a tool this connector actually offers this principal *and* an admin allow-listed.
      const tool = ctx.connectorTools?.find(
        (t) => t.alias === effect.connector && t.name === effect.tool,
      );
      if (!tool) {
        return err(`${effect.connector}.${effect.tool} is not a connector tool available here`);
      }
      if (JSON.stringify(effect.arguments).length > MAX_ACT_ARGS_CHARS) {
        return err(`arguments are limited to ${MAX_ACT_ARGS_CHARS} characters`);
      }
      params = {
        kind: 'connector-action',
        connector: tool.alias,
        collection: tool.collection,
        tool: tool.name,
        summary: clean(effect.summary).replace(/\s+/g, ' ').trim().slice(0, 300),
        arguments: effect.arguments,
      };
      break;
    }
    case 'react':
      if (!msgOk(effect.target.channel, effect.target.ts)) {
        return err('that permalink is not a message from the captured context');
      }
      if (!channelOk(effect.target.channel)) {
        return err(`<#${effect.target.channel}> is not a conversation named in this request`);
      }
      params = {
        kind: 'react',
        channel: effect.target.channel,
        ts: effect.target.ts,
        emoji: effect.emoji,
      };
      break;
  }

  const parsed = ActuationParamsSchema.safeParse(params);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'invalid effect');
  const p = parsed.data;
  const label = KIND_LABELS[p.kind];
  return {
    ok: true,
    effect: {
      changeId: (ctx.newChangeId ?? (() => `chg_${randomUUID()}`))(),
      params: p,
      line,
      label: describe(p),
      preview: previewOf(p),
      approvalClass: approvalClassOf(p, ctx.originChannel),
      reversible: label.undo !== 'Not reversible',
      ...(p.kind === 'connector-action' ? { detail: prettyArgs(p.arguments) } : {}),
    },
  };
}

function describe(p: ActuationParams): string {
  const l = KIND_LABELS[p.kind].label;
  switch (p.kind) {
    case 'action-items':
      return `${l} (${p.items.length}) “${mrkdwnEscape(p.title)}”`;
    case 'post':
      return `${l} in <#${p.channel}>`;
    case 'canvas':
      return `${l} “${mrkdwnEscape(p.title)}”`;
    case 'schedule':
      return `${l} to <#${p.channel}> · <!date^${p.postAt}^{date_short_pretty} {time}|${new Date(p.postAt * 1000).toISOString()}>`;
    case 'remind':
      return `${l} <@${p.user}> · <!date^${p.postAt}^{date_short_pretty} {time}|${new Date(p.postAt * 1000).toISOString()}>`;
    case 'bookmark':
      return `${l} “${mrkdwnEscape(p.title)}”`;
    case 'react':
      return `${l} :${p.emoji}:`;
    case 'connector-action':
      return `${l}: ${p.connector} · ${p.tool}`;
    default:
      return l;
  }
}

function previewOf(p: ActuationParams): string {
  switch (p.kind) {
    case 'reply':
    case 'post':
    case 'schedule':
    case 'remind':
      return preview(p.text);
    case 'canvas':
    case 'canvas-edit':
      return preview(p.markdown);
    case 'bookmark':
      return p.link;
    case 'connector-action':
      return preview(p.summary);
    case 'react':
      return `:${p.emoji}:`;
    case 'action-items':
      return preview(
        p.items
          .map(
            (i) => `${i.owner ? `<@${i.owner}> ` : ''}${i.text}${i.due ? ` (due ${i.due})` : ''}`,
          )
          .join(' · '),
      );
  }
}

/**
 * `action` lines become ONE action-items effect (one list, one approval, one undo). Owners must be
 * people who appeared in the turn; due dates must be real calendar dates.
 */
export function compileActionItems(
  lines: Array<{ effect: Extract<CmdEffect, { kind: 'action-item' }>; line: string }>,
  ctx: CompileContext,
  title: string,
): CompileResult {
  const first = lines[0];
  if (!first) return { ok: false, error: 'no action items' };
  const errors: string[] = [];
  const items = lines.flatMap(({ effect, line }) => {
    if (effect.owner && !ctx.knownUsers.has(effect.owner)) {
      errors.push(`${line}: <@${effect.owner}> did not appear in this conversation`);
      return [];
    }
    if (effect.due && Number.isNaN(Date.parse(`${effect.due}T00:00:00Z`))) {
      errors.push(`${line}: ${effect.due} is not a real date`);
      return [];
    }
    return [
      {
        text: sanitizeOutbound(effect.text, ctx.knownUsers).slice(0, 500),
        ...(effect.owner ? { owner: effect.owner } : {}),
        ...(effect.due ? { due: effect.due } : {}),
      },
    ];
  });
  if (errors.length) return { ok: false, error: errors.join('\n') };
  const s = ctx.scope;
  const channel =
    s.kind === 'thread' ||
    s.kind === 'message' ||
    s.kind === 'channel' ||
    s.kind === 'dm' ||
    s.kind === 'search'
      ? s.channel
      : ctx.originChannel;
  if (!channel || !ctx.allowedChannels.has(channel)) {
    return { ok: false, error: `${first.line}: action items need a conversation to attach to` };
  }
  const threadTs = s.kind === 'thread' || s.kind === 'message' ? s.ts : undefined;
  const parsed = ActuationParamsSchema.safeParse({
    kind: 'action-items',
    title: sanitizeOutbound(title, ctx.knownUsers).slice(0, 150),
    items,
    channel,
    ...(threadTs ? { threadTs } : {}),
  });
  if (!parsed.success)
    return { ok: false, error: `${first.line}: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const p = parsed.data;
  return {
    ok: true,
    effect: {
      changeId: (ctx.newChangeId ?? (() => `chg_${randomUUID()}`))(),
      params: p,
      line: lines.map((l) => l.line).join('\n'),
      label: describe(p),
      preview: previewOf(p),
      approvalClass: approvalClassOf(p, ctx.originChannel),
      reversible: true,
    },
  };
}
