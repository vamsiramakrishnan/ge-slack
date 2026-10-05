import { describe, expect, it } from 'vitest';
import { decidePrincipal, type PrincipalDecisionInput } from './principal.js';
import { approvalClassOf, canAutoApply } from './actuation.js';
import { fromSlackMetadata, toSlackMetadata, type WriteProvenance } from './provenance.js';
import { deriveOutput, isActuating } from './intent.js';

const base: PrincipalDecisionInput = {
  policy: 'user-only',
  linked: false,
  offlineGranted: false,
  unattended: false,
  externallyShared: false,
  serviceConfigured: true,
};

describe('decidePrincipal', () => {
  it('user-only: linked → user; unlinked → connect prompt without service offer', () => {
    expect(decidePrincipal({ ...base, linked: true })).toEqual({ ok: true, kind: 'user' });
    const r = decidePrincipal(base);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('needs-link');
    expect(!r.ok && r.offerService).toBe(false);
  });

  it('user-only denies --as service', () => {
    const r = decidePrincipal({ ...base, linked: true, requested: 'service' });
    expect(!r.ok && r.reason).toBe('service-denied');
  });

  it('user-preferred offers the service to unlinked users and honours --as service', () => {
    const r = decidePrincipal({ ...base, policy: 'user-preferred' });
    expect(!r.ok && r.offerService).toBe(true);
    expect(decidePrincipal({ ...base, policy: 'user-preferred', requested: 'service' })).toEqual({
      ok: true,
      kind: 'service',
    });
  });

  it('service-only always uses service and refuses --as me', () => {
    expect(decidePrincipal({ ...base, policy: 'service-only', linked: true })).toMatchObject({
      ok: true,
      kind: 'service',
    });
    expect(decidePrincipal({ ...base, policy: 'service-only', requested: 'me' }).ok).toBe(false);
  });

  it('coerces externally shared channels to service with an explanation', () => {
    const r = decidePrincipal({ ...base, linked: true, externallyShared: true });
    expect(r).toMatchObject({ ok: true, kind: 'service' });
    expect(r.ok && r.coerced).toBeTruthy();
  });

  it('fails closed when no service account is configured', () => {
    const r = decidePrincipal({ ...base, policy: 'service-only', serviceConfigured: false });
    expect(!r.ok && r.reason).toBe('service-unavailable');
  });

  it('unattended runs: run-as-me requires link + offline access', () => {
    const u = { ...base, unattended: true, requested: 'me' as const };
    expect(decidePrincipal(u).ok).toBe(false);
    expect(!decidePrincipal({ ...u, linked: true }).ok && 'offline').toBeTruthy();
    expect(decidePrincipal({ ...u, linked: true, offlineGranted: true })).toEqual({
      ok: true,
      kind: 'user',
    });
  });

  it('unattended runs without a choice never silently use service in user-only channels', () => {
    const r = decidePrincipal({ ...base, unattended: true, linked: true });
    expect(!r.ok && r.reason).toBe('offline-required');
    expect(decidePrincipal({ ...base, unattended: true, policy: 'user-preferred' })).toMatchObject({
      kind: 'service',
    });
  });
});

describe('actuation policy', () => {
  it('classifies approval', () => {
    expect(
      approvalClassOf({ kind: 'reply', channel: 'C1A', threadTs: '1.000001', text: 'x' }, 'C1A'),
    ).toBe('in-conversation');
    expect(approvalClassOf({ kind: 'post', channel: 'C2B', text: 'x' }, 'C1A')).toBe('external');
    expect(approvalClassOf({ kind: 'schedule', channel: 'C1A', postAt: 1, text: 'x' }, 'C1A')).toBe(
      'external',
    );
  });

  it('auto-apply gate fails closed', () => {
    const reply = { kind: 'reply' as const, channel: 'C1A', threadTs: '1.000001', text: 'x' };
    const ctx = {
      originChannel: 'C1A',
      originThreadTs: '1.000001',
      destination: 'C9Z',
      channelAutoApply: true,
    };
    expect(canAutoApply(reply, ctx)).toBe(true);
    expect(canAutoApply(reply, { ...ctx, channelAutoApply: false })).toBe(false);
    expect(canAutoApply({ ...reply, threadTs: '2.000002' }, ctx)).toBe(false);
    expect(canAutoApply({ kind: 'post', channel: 'C9Z', text: 'x' }, ctx)).toBe(true);
    expect(canAutoApply({ kind: 'post', channel: 'C1A', text: 'x' }, ctx)).toBe(false);
    expect(canAutoApply({ kind: 'canvas', title: 't', markdown: 'm' }, ctx)).toBe(false);
  });
});

describe('provenance metadata', () => {
  it('round-trips without excerpts', () => {
    const p: WriteProvenance = {
      changeId: 'chg_12345678',
      agentId: 'gemini-enterprise:eng',
      principal: 'user:alex@acme.com',
      invoker: 'U0ALEX',
      approvedBy: 'U0ALEX',
      approval: 'human',
      edited: false,
      timestamp: '2026-10-05T10:00:00.000Z',
      contentHash: 'sha256:abc',
      sources: [{ title: 'Runbook', uri: 'https://x' }],
    };
    const meta = toSlackMetadata(p);
    expect(JSON.stringify(meta)).not.toContain('excerpt');
    expect(fromSlackMetadata(meta)).toEqual(p);
    expect(fromSlackMetadata({ event_type: 'other', event_payload: {} })).toBeUndefined();
  });
});

describe('intent routing', () => {
  it('is total: writing verbs always actuate', () => {
    expect(isActuating('rewrite')).toBe(true);
    expect(isActuating('draft')).toBe(true);
    expect(isActuating('ask')).toBe(false);
    expect(deriveOutput('review')).toBe('annotation');
  });
});
