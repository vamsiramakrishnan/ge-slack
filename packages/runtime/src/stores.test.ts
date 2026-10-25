import { describe, expect, it } from 'vitest';
import { InvocationSchema, type Origin } from '@ge-slack/contracts';
import { MemoryStore, type KeyValueStore } from '@ge-slack/identity';
import {
  RuntimeStores,
  type EffectClaim,
  type PendingPlan,
  type StoredAnswer,
  type AgentContinuation,
} from './stores.js';

const claim: EffectClaim = {
  version: 1,
  direction: 'apply',
  teamId: 'T1',
  changeId: 'change-1',
  invokerId: 'U1',
  principalHash: 'sha256:' + 'a'.repeat(64),
  intentHash: 'sha256:' + 'b'.repeat(64),
  kind: 'reply',
  startedAt: '2026-10-25T00:00:00Z',
};

describe('durable effect claims', () => {
  it('allows one competing owner across store instances and restart', async () => {
    const kv = new MemoryStore();
    const stores = Array.from({ length: 20 }, () => new RuntimeStores(kv));
    const results = await Promise.all(stores.map((store) => store.claimEffect(claim)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new RuntimeStores(kv).claimEffect(claim)).toBe(false);
    expect(
      await stores[0]!.claimEffect({ ...claim, principalHash: 'sha256:' + 'c'.repeat(64) }),
    ).toBe(false);
    expect(await stores[0]!.claimEffect({ ...claim, direction: 'undo' })).toBe(true);
    expect(await kv.list('effect-claim/')).toHaveLength(1);
  });
  it('persists only explicit bounded metadata with no approval or source bodies', async () => {
    const kv = new MemoryStore();
    await new RuntimeStores(kv).claimEffect({
      ...claim,
      approval: 'secret-approval',
      body: 'source-body',
      tokens: 'bearer',
    } as EffectClaim);
    const stored = JSON.stringify(await kv.list('effect-claim/'));
    expect(stored).not.toContain('secret-approval');
    expect(stored).not.toContain('source-body');
    expect(stored).not.toContain('bearer');
    expect(stored).toContain(claim.intentHash);
  });
  it('refuses weak fingerprints and oversized metadata', async () => {
    const store = new RuntimeStores(new MemoryStore());
    await expect(store.claimEffect({ ...claim, intentHash: 'fnv1a32:deadbeef' })).rejects.toThrow(
      'Invalid',
    );
    await expect(store.claimEffect({ ...claim, changeId: 'x'.repeat(201) })).rejects.toThrow(
      'Invalid',
    );
    await expect(store.claimEffect({ ...claim, startedAt: 'x'.repeat(1000) })).rejects.toThrow(
      'Invalid',
    );
  });
  it('fails closed for adapters with no atomic create operation', async () => {
    const kv = new MemoryStore();
    Object.defineProperty(kv, 'create', { value: undefined });
    await expect(new RuntimeStores(kv as KeyValueStore).claimEffect(claim)).rejects.toThrow(
      'atomically',
    );
    expect(await kv.list('effect-claim/')).toEqual([]);
  });
});

describe('durable origins omit Slack bearer capabilities', () => {
  function fixtures() {
    const origin: Origin = Object.freeze({
      entry: 'slash',
      teamId: 'T1',
      userId: 'U0ALEX',
      channelId: 'C0ENG',
      responseUrl: 'https://hooks.slack.com/commands/T1/bearer-secret',
      triggerId: 'modal-capability-secret',
    });
    const invocation = InvocationSchema.parse({ verb: 'draft' });
    const now = Date.now();
    const plan: PendingPlan = {
      id: 'p',
      teamId: 'T1',
      invokerId: 'U0ALEX',
      origin,
      invocation,
      scope: { kind: 'none' },
      effects: [],
      sources: [],
      agentId: 'gemini',
      contentHash: 'hash',
      identity: 'user:alex@acme.com',
      dryRun: false,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const answer: StoredAnswer = {
      turnId: 'a',
      teamId: 'T1',
      invokerId: 'U0ALEX',
      origin,
      text: 'Prepared answer',
      principal: 'user:alex@acme.com',
    };
    const resume = { origin, invocation };
    const agent: AgentContinuation = {
      id: 'c',
      teamId: 'T1',
      invokerId: 'U0ALEX',
      origin,
      invocation,
      agentAlias: 'triage',
      agentId: 'agent',
      reason: 'input-required',
      handle: { contextId: 'context' },
      identity: 'user:alex@acme.com',
      expiresAt: now + 60_000,
    };
    return { origin, plan, answer, resume, agent, now };
  }
  function assertRedacted(value: { origin: Origin } | undefined) {
    expect(value).toBeDefined();
    expect(value!.origin).toMatchObject({
      entry: 'slash',
      teamId: 'T1',
      userId: 'U0ALEX',
      channelId: 'C0ENG',
    });
    expect(value!.origin.responseUrl).toBeUndefined();
    expect(value!.origin.triggerId).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('bearer-secret');
    expect(JSON.stringify(value)).not.toContain('modal-capability-secret');
  }
  it('redacts every saved record without mutating the live origin', async () => {
    const data = fixtures();
    const kv = new MemoryStore();
    const stores = new RuntimeStores(kv);
    await stores.savePlan(data.plan);
    await stores.saveAnswer(data.answer);
    await stores.saveResume('r', data.resume);
    await stores.saveContinuation(data.agent, data.now);
    for (const key of ['plan/p', 'answer/a', 'resume/r', 'agent/c'])
      assertRedacted(await kv.get<{ origin: Origin }>(key));
    expect(data.origin.responseUrl).toContain('bearer-secret');
    expect(data.origin.triggerId).toBe('modal-capability-secret');
    expect(data.plan.origin).toBe(data.origin);
    expect(data.answer.origin).toBe(data.origin);
    expect(data.resume.origin).toBe(data.origin);
    expect(data.agent.origin).toBe(data.origin);
  });
  it('redacts legacy get/take paths while preserving atomic consumption', async () => {
    const data = fixtures();
    const kv = new MemoryStore();
    const stores = new RuntimeStores(kv);
    await kv.set('plan/p', data.plan);
    await kv.set('answer/a', data.answer);
    await kv.set('resume/r', data.resume);
    await kv.set('agent/c', data.agent);
    for (const value of [
      await stores.getPlan('p'),
      await stores.getAnswer('a'),
      await stores.getResume('r'),
      await stores.getContinuation('c'),
    ])
      assertRedacted(value);
    for (const value of [
      await stores.takePlan('p'),
      await stores.takeResume('r'),
      await stores.takeContinuation('c'),
    ])
      assertRedacted(value);
    expect(await stores.takePlan('p')).toBeUndefined();
    expect(await stores.takeResume('r')).toBeUndefined();
    expect(await stores.takeContinuation('c')).toBeUndefined();
    expect(data.origin.responseUrl).toContain('bearer-secret');
    expect(data.origin.triggerId).toBe('modal-capability-secret');
  });
});
