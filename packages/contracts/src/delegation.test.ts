import { describe, expect, it } from 'vitest';
import {
  checkGrant,
  faqClean,
  isSelfScoped,
  looksLikeQuestion,
  type DelegationGrant,
} from './index.js';

const NOW = Date.parse('2026-10-07T10:00:00Z');
const g: DelegationGrant = {
  automationId: 'a1',
  teamId: 'T1',
  ownerId: 'U1',
  subject: 'sub-1',
  channels: ['C1'],
  destinations: ['C2'],
  grantedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2026-10-31T00:00:00Z',
};

describe('checkGrant', () => {
  const ok = { now: NOW, subject: 'sub-1', reads: ['C1'], writes: ['C2'] };
  it('allows exactly what was granted, to the same subject, before expiry', () => {
    expect(checkGrant(g, ok)).toEqual({ ok: true });
    expect(checkGrant(undefined, ok)).toMatchObject({ ok: false, reason: 'no-grant' });
    expect(checkGrant(g, { ...ok, now: Date.parse(g.expiresAt) })).toMatchObject({
      reason: 'expired',
    });
    expect(checkGrant(g, { ...ok, subject: 'sub-2' })).toMatchObject({ reason: 'subject-changed' });
    expect(checkGrant(g, { ...ok, subject: undefined })).toMatchObject({
      reason: 'subject-changed',
    });
    expect(checkGrant(g, { ...ok, reads: ['C1', 'C9'] })).toMatchObject({
      reason: 'channel-not-granted',
    });
    expect(checkGrant(g, { ...ok, writes: ['C1'] })).toMatchObject({
      reason: 'destination-not-granted',
    });
  });
});

describe('isSelfScoped', () => {
  const all = new Set(['dm-reply', 'remind-self'] as const);
  const dm = { channel: 'D1', threadTs: '1.1' };
  it('only your own DM and reminders to yourself, only when opted in, never with pings', () => {
    expect(
      isSelfScoped(
        { kind: 'reply', channel: 'D1', threadTs: '1.1', text: 'ok' },
        { userId: 'U1', trusted: all, dm },
      ),
    ).toBe(true);
    expect(
      isSelfScoped({ kind: 'post', channel: 'D1', text: 'ok' }, { userId: 'U1', trusted: all, dm }),
    ).toBe(true);
    expect(
      isSelfScoped(
        { kind: 'reply', channel: 'D1', threadTs: '2.2', text: 'ok' },
        { userId: 'U1', trusted: all, dm },
      ),
    ).toBe(false);
    expect(
      isSelfScoped(
        { kind: 'post', channel: 'C1', text: 'ok' },
        { userId: 'U1', trusted: all, dm: { channel: 'C1' } },
      ),
    ).toBe(false);
    expect(
      isSelfScoped(
        { kind: 'post', channel: 'D1', text: 'hi <@U2>' },
        { userId: 'U1', trusted: all, dm },
      ),
    ).toBe(false);
    expect(
      isSelfScoped(
        { kind: 'post', channel: 'D1', text: 'ok' },
        { userId: 'U1', trusted: new Set(), dm },
      ),
    ).toBe(false);
    expect(
      isSelfScoped(
        { kind: 'remind', user: 'U1', postAt: 2e9, text: 'x' },
        { userId: 'U1', trusted: all },
      ),
    ).toBe(true);
    expect(
      isSelfScoped(
        { kind: 'remind', user: 'U2', postAt: 2e9, text: 'x' },
        { userId: 'U1', trusted: all },
      ),
    ).toBe(false);
  });
});

describe('looksLikeQuestion / faqClean', () => {
  it('spots questions conservatively', () => {
    expect(looksLikeQuestion('How do I rotate the cache key')).toBe(true);
    expect(looksLikeQuestion('Anyone know where the runbook is?')).toBe(true);
    expect(looksLikeQuestion('deployed, all good')).toBe(false);
    expect(looksLikeQuestion('ok?')).toBe(false);
    expect(looksLikeQuestion('<!channel> who is on call?')).toBe(false);
  });
  it('removes pings and Slack ids from text others will read', () => {
    expect(faqClean('Ask <@U123|dana> in <#C9|ops> <!here>', 200)).toBe('Ask a teammate in #ops');
  });
});
