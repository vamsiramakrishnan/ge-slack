import { randomUUID } from 'node:crypto';
import {
  ActuationParamsSchema,
  KIND_LABELS,
  approvalClassOf,
  type ActuationParams,
  type ApprovalClass,
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
}

export interface CompiledEffect {
  changeId: string;
  params: ActuationParams;
  line: string;
  label: string;
  preview: string;
  approvalClass: ApprovalClass;
  reversible: boolean;
}

export type CompileResult = { ok: true; effect: CompiledEffect } | { ok: false; error: string };

const MAX_FUTURE_S = 120 * 86_400;

/**
 * Model text is posted under our app's name, so it is sanitized before it can land:
 * broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, user groups) are defused, and user
 * mentions are kept only for people who appeared in the turn — the model never pings strangers.
 */
export function sanitizeOutbound(text: string, knownUsers: ReadonlySet<string>): string {
  return text
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, (_m, w: string) => `@⁠${w}`)
    .replace(
      /<!subteam\^[A-Z0-9]+(\|([^>]*))?>/gi,
      (_m, _l, label: string | undefined) => label ?? '@group',
    )
    .replace(
      /(^|[^\w])@(channel|here|everyone)\b/gi,
      (_m, pre: string, w: string) => `${pre}@⁠${w}`,
    )
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (m, id: string) =>
      knownUsers.has(id) ? `<@${id}>` : 'someone',
    );
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
        title: effect.title.slice(0, 150),
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
      };
      break;
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
      params = { kind: 'bookmark', channel, title: effect.title, link: effect.link };
      break;
    }
    case 'react':
      if (!msgOk(effect.target.channel, effect.target.ts)) {
        return err('that permalink is not a message from the captured context');
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
    },
  };
}

function describe(p: ActuationParams): string {
  const l = KIND_LABELS[p.kind].label;
  switch (p.kind) {
    case 'post':
      return `${l} in <#${p.channel}>`;
    case 'canvas':
      return `${l} “${p.title}”`;
    case 'schedule':
      return `${l} to <#${p.channel}> · <!date^${p.postAt}^{date_short_pretty} {time}|${new Date(p.postAt * 1000).toISOString()}>`;
    case 'remind':
      return `${l} <@${p.user}> · <!date^${p.postAt}^{date_short_pretty} {time}|${new Date(p.postAt * 1000).toISOString()}>`;
    case 'bookmark':
      return `${l} “${p.title}”`;
    case 'react':
      return `${l} :${p.emoji}:`;
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
    case 'react':
      return `:${p.emoji}:`;
  }
}
