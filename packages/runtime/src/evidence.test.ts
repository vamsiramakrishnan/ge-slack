import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_LIMITS,
  ReadWorkspace,
  captureReceipt,
  contextHash,
  mergeContext,
  utf8Bytes,
} from './evidence.js';
import type { CapturedContext } from './ports.js';

const empty = (): CapturedContext => ({
  label: 'source',
  channel: 'CONE',
  messages: [],
  truncated: false,
});
describe('bounded evidence working sets', () => {
  it('keeps same-timestamp messages in distinct conversations and replaces observed edits', () => {
    const ctx = empty();
    ctx.messages = [{ channel: 'CONE', ts: '123456.1', text: 'old' }];
    mergeContext(ctx, {
      ...empty(),
      channel: 'CTWO',
      messages: [{ ts: '123456.1', text: 'other' }],
    });
    mergeContext(ctx, { ...empty(), messages: [{ ts: '123456.1', text: 'edited' }] });
    expect(ctx.messages.map((m) => m.text)).toEqual(['other', 'edited']);
  });
  it('counts a retained canvas and all serialized wrappers when new messages arrive', () => {
    const ctx = {
      ...empty(),
      canvas: { id: 'FONE', title: 'Large', markdown: '漢'.repeat(87000) },
    };
    mergeContext(ctx, {
      ...empty(),
      messages: Array.from({ length: 200 }, (_, i) => ({
        ts: `${123456 + i}.1`,
        text: 'x'.repeat(3000),
      })),
    });
    expect(utf8Bytes(JSON.stringify(ctx))).toBeLessThanOrEqual(EVIDENCE_LIMITS.bytes);
    expect(ctx.truncated).toBe(true);
  });
  it('hashes source identities/content rather than display names and cursors', async () => {
    const ctx = { ...empty(), messages: [{ ts: '123456.1', text: 'known', author: 'Before' }] };
    const before = await contextHash(ctx);
    ctx.messages[0]!.author = 'After';
    expect(await contextHash(ctx)).toBe(before);
    ctx.messages[0]!.text = 'changed';
    expect(await contextHash(ctx)).not.toBe(before);
    const receipt = await captureReceipt(
      { kind: 'thread', channel: 'CONE', ts: '123456.1' },
      { from: [], maxMessages: 100 },
      ctx,
    );
    expect(JSON.stringify(receipt)).not.toContain('changed');
  });
  it('binds opaque continuation handles to the exact scope and author filter for this turn', async () => {
    const ctx = {
      ...empty(),
      coverage: {
        complete: false,
        order: 'oldest_first' as const,
        pages: 1,
        capturedMessages: 0,
        capturedBytes: 0,
        omittedMessages: 0,
        omittedBytes: 0,
        nextCursor: 'native-private-cursor',
      },
    };
    const workspace = new ReadWorkspace();
    await workspace.record(
      { kind: 'thread', channel: 'CONE', ts: '123456.1' },
      { from: ['UALICE'], maxMessages: 10 },
      ctx,
    );
    expect(ctx.continuation).toMatch(/^p_[a-f0-9]{32}$/);
    expect(workspace.continuations.get(ctx.continuation!)).toMatchObject({
      scope: { kind: 'thread', channel: 'CONE', ts: '123456.1' },
      options: { from: ['UALICE'], maxMessages: 10, cursor: 'native-private-cursor' },
    });
    expect(new ReadWorkspace().continuations.has(ctx.continuation!)).toBe(false);
  });
});
