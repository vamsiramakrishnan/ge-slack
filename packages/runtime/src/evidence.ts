import { contentHash } from '@ge-slack/gemini-client';
import type { CapturedContext, CapturedMessage, ResolvedScope } from './ports.js';

export const EVIDENCE_LIMITS = { bytes: 256 * 1024, messages: 400, reads: 8 } as const;
export interface CaptureOptions {
  from: string[];
  maxMessages: number;
  cursor?: string;
}
/** Server-owned proof of the captured window, without bodies or bearer credentials. */
export interface SourceReceipt {
  scope: ResolvedScope;
  options: CaptureOptions;
  hash: string;
  complete: boolean;
  /** Set by the measured prompt renderer, never inferred from native capture size. */
  modelComplete?: boolean;
}
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
export function utf8Prefix(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const encoded = new TextEncoder().encode(text);
  return encoded.byteLength <= bytes
    ? text
    : new TextDecoder().decode(encoded.subarray(0, bytes), { stream: true });
}
export async function captureReceipt(
  scope: ResolvedScope,
  options: CaptureOptions,
  ctx: CapturedContext,
): Promise<SourceReceipt> {
  return {
    scope: structuredClone(scope),
    options: structuredClone(options),
    hash: await contextHash(ctx),
    complete: !ctx.truncated && (ctx.coverage?.complete ?? true),
  };
}
export function contextHash(ctx: CapturedContext): Promise<string> {
  // Display names, permalinks and cursors are not a source revision. Identity and content are.
  return contentHash(
    JSON.stringify({
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      messages: ctx.messages.map((m) => ({
        channel: m.channel ?? ctx.channel,
        ts: m.ts,
        user: m.user,
        text: m.text,
        threadTs: m.threadTs,
        replyCount: m.replyCount,
        fromApp: m.fromApp,
      })),
      canvas: ctx.canvas ? { id: ctx.canvas.id, markdown: ctx.canvas.markdown } : undefined,
      truncated: ctx.truncated,
      complete: ctx.coverage?.complete,
    }),
  );
}
export function messageKey(message: CapturedMessage, channel?: string): string {
  return `${message.channel ?? channel ?? ''}:${message.ts}`;
}
/** Bounded retained working set. Later reads replace edits at the same native identity. */
export function mergeContext(ctx: CapturedContext, more: CapturedContext): number {
  const byKey = new Map(ctx.messages.map((m) => [messageKey(m, ctx.channel), m]));
  let added = 0;
  for (const m of more.messages) {
    const message = { ...m, channel: m.channel ?? more.channel };
    const key = messageKey(message, more.channel);
    if (!byKey.has(key)) added++;
    byKey.delete(key);
    byKey.set(key, message);
  }
  const all = [...byKey.values()];
  const canvas = more.canvas ?? ctx.canvas;
  const next = {
    ...ctx,
    ...(canvas ? { canvas: { ...canvas } } : {}),
    messages: [] as CapturedMessage[],
  };
  let omitted = false;
  for (const message of all.reverse()) {
    next.messages.unshift(message);
    if (
      next.messages.length > EVIDENCE_LIMITS.messages ||
      utf8Bytes(JSON.stringify(next)) > EVIDENCE_LIMITS.bytes
    ) {
      next.messages.shift();
      omitted = true;
    }
  }
  next.truncated = ctx.truncated || more.truncated || omitted;
  if (more.coverage)
    next.coverage = { ...more.coverage, complete: !next.truncated && more.coverage.complete };
  // Native capture excludes coverage from its byte count; retained state includes every wrapper.
  if (utf8Bytes(JSON.stringify(next)) > EVIDENCE_LIMITS.bytes && next.canvas) {
    const excess = utf8Bytes(JSON.stringify(next)) - EVIDENCE_LIMITS.bytes;
    next.canvas.markdown = utf8Prefix(
      next.canvas.markdown,
      Math.max(0, utf8Bytes(next.canvas.markdown) - excess - 256),
    );
    next.truncated = true;
    if (next.coverage) next.coverage.complete = false;
  }
  Object.assign(ctx, next);
  return added;
}
export class ReadWorkspace {
  readonly receipts: SourceReceipt[] = [];
  readonly continuations = new Map<string, { scope: ResolvedScope; options: CaptureOptions }>();
  reads = 0;
  async record(scope: ResolvedScope, options: CaptureOptions, ctx: CapturedContext): Promise<void> {
    if (this.receipts.length >= EVIDENCE_LIMITS.reads + 1)
      throw new Error('Source evidence budget exhausted.');
    this.receipts.push(await captureReceipt(scope, options, ctx));
    delete ctx.continuation;
    if (ctx.coverage?.nextCursor && scope.kind !== 'search') {
      const id = `p_${crypto.randomUUID().replaceAll('-', '')}`;
      this.continuations.set(id, {
        scope: structuredClone(scope),
        options: { ...structuredClone(options), cursor: ctx.coverage.nextCursor },
      });
      ctx.continuation = id;
    }
  }
}
