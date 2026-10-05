import { describe, expect, it } from 'vitest';
import type { Principal } from '@ge-slack/contracts';
import { MemoryStore, type Resolved, type ResolveInput } from '@ge-slack/identity';
import {
  KvWorkspaceConfig,
  Orchestrator,
  RuntimeStores,
  type IdentityPort,
} from '@ge-slack/runtime';
import { FakeGemini, FakeSurface, RecordingSink } from '@ge-slack/runtime/testing';
import { nextCronRun, parseCron } from './cron.js';
import { AutomationEngine } from './engine.js';
import { runWorkflowStep } from './workflow.js';

describe('cron', () => {
  it('computes weekday mornings in a time zone across DST', () => {
    // Fri 2026-10-30 17:00Z → next weekday 09:00 in Los Angeles is Mon 2026-11-02 (PST, UTC-8).
    const next = nextCronRun(
      '0 9 * * 1-5',
      new Date('2026-10-30T17:00:00Z'),
      'America/Los_Angeles',
    );
    expect(next?.toISOString()).toBe('2026-11-02T17:00:00.000Z');
    // Before the DST change the same slot is UTC-7.
    expect(
      nextCronRun(
        '0 9 * * 1-5',
        new Date('2026-10-29T15:00:00Z'),
        'America/Los_Angeles',
      )?.toISOString(),
    ).toBe('2026-10-29T16:00:00.000Z');
  });
  it('handles steps, lists and dom/dow OR semantics', () => {
    expect(nextCronRun('*/15 * * * *', new Date('2026-10-05T10:07:30Z'))?.toISOString()).toBe(
      '2026-10-05T10:15:00.000Z',
    );
    expect(nextCronRun('30 8 1 * 1', new Date('2026-10-05T09:00:00Z'))?.toISOString()).toBe(
      '2026-10-12T08:30:00.000Z',
    );
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });
});

class Identity implements IdentityPort {
  serviceConfigured = true;
  serviceAccount = 'ge-bot@p1.iam.gserviceaccount.com';
  async resolve(input: ResolveInput): Promise<Resolved> {
    if (input.policy === 'user-only' && input.requested === 'service') {
      return {
        ok: false,
        decision: {
          ok: false,
          reason: 'service-denied',
          offerService: false,
          message: 'Service not allowed here.',
        },
      };
    }
    const principal: Principal = {
      kind: 'service',
      serviceAccount: this.serviceAccount,
      onBehalfOf: { teamId: input.teamId, slackUserId: input.userId },
    };
    return {
      ok: true,
      principal,
      tokens: { getAccessToken: async () => 's' },
      identity: `service:${this.serviceAccount}`,
    };
  }
  async getLinked() {
    return undefined;
  }
  async unlink() {}
  async setAllowUnattended() {
    return false;
  }
}

function world(script: string[]) {
  const kv = new MemoryStore();
  const surface = new FakeSurface();
  surface.members.set('C0ENG', new Set(['U0ALEX', 'U0RUNNER']));
  surface.members.set('C0DIG', new Set(['U0ALEX']));
  surface.contexts.set('C0ENG', {
    label: '#eng',
    channel: 'C0ENG',
    messages: [{ ts: '1700000000.000100', user: 'U0MAYA', text: 'shipped' }],
    truncated: false,
  });
  surface.contexts.set('C0ENG:1700000000.000100', {
    label: 'thread',
    channel: 'C0ENG',
    messages: [{ ts: '1700000000.000100', user: 'U0MAYA', text: 'incident' }],
    truncated: false,
  });
  const config = new KvWorkspaceConfig(kv, []);
  let now = new Date('2026-10-05T08:59:00Z');
  const clock = () => now;
  const orch = new Orchestrator({
    surface,
    gemini: new FakeGemini(script),
    identity: new Identity(),
    config,
    stores: new RuntimeStores(kv),
    now: clock,
  });
  const engine = new AutomationEngine(kv, clock);
  const sinks: RecordingSink[] = [];
  const sinkFor = () => {
    const s = new RecordingSink();
    sinks.push(s);
    return s;
  };
  return {
    kv,
    surface,
    config,
    orch,
    engine,
    sinks,
    sinkFor,
    setNow: (d: string) => (now = new Date(d)),
  };
}

const digest = {
  teamId: 'T1',
  ownerId: 'U0ALEX',
  channelId: 'C0ENG',
  trigger: { kind: 'schedule' as const, text: 'daily 9:00', cron: '0 9 * * *', timeZone: 'UTC' },
  invocation: {
    verb: 'summarize' as const,
    inferredVerb: false,
    grounds: [],
    people: [],
    from: [],
    instruction: '',
    flags: {},
  },
  runAs: 'service' as const,
  destination: 'C0DIG',
  enabled: true,
};

describe('AutomationEngine', () => {
  it('runs due schedules once per slot, as the configured principal, into the destination', async () => {
    const w = world(['Digest: shipped.', 'Digest 2']);
    await w.config.setChannelPolicy('T1', 'C0ENG', {
      identity: 'user-preferred',
      serviceGrounds: [],
      serviceMayRead: true,
      autoApply: false,
    });
    const a = await w.engine.create(digest);
    expect(await w.engine.tick(w.orch, 'T1', w.sinkFor)).toEqual([]);
    w.setNow('2026-10-05T09:00:30Z');
    expect(await w.engine.tick(w.orch, 'T1', w.sinkFor)).toEqual([a.id]);
    expect(await w.engine.tick(w.orch, 'T1', w.sinkFor)).toEqual([]); // retried tick: no double run
    const answer = w.sinks[0]!.last<{ text: string; identity: { kind: string } }>('answer');
    expect(answer).toMatchObject({ text: 'Digest: shipped.', identity: { kind: 'service' } });
    expect((await w.engine.get('T1', a.id))?.lastOutcome).toBe('ok');
  });

  it('auto-suspends after repeated denied runs', async () => {
    const w = world([]);
    // user-only channel: the service principal is denied every time.
    const a = await w.engine.create(digest);
    for (let i = 0; i < 3; i++) await w.engine.runNow(w.orch, 'T1', a.id, 'U0ALEX', w.sinkFor);
    const after = await w.engine.get('T1', a.id);
    expect(after?.enabled).toBe(false);
    expect(after?.suspendedReason).toContain('paused after 3 failed runs');
  });

  it('only the owner can manage or run an automation', async () => {
    const w = world([]);
    const a = await w.engine.create(digest);
    expect(await w.engine.manage('T1', a.id, 'U0MAYA', 'delete')).toContain('Only the owner');
    expect(await w.engine.runNow(w.orch, 'T1', a.id, 'U0MAYA', w.sinkFor)).toContain(
      'Only the owner',
    );
    expect(await w.engine.manage('T1', a.id, 'U0ALEX', 'toggle')).toBe('Automation paused.');
  });

  it('reaction triggers run on the thread and are debounced', async () => {
    const w = world(['Notes A', 'Notes B']);
    await w.config.setChannelPolicy('T1', 'C0ENG', {
      identity: 'user-preferred',
      serviceGrounds: [],
      serviceMayRead: true,
      autoApply: false,
    });
    await w.engine.create({
      ...digest,
      trigger: { kind: 'reaction', emoji: 'memo', channel: 'C0ENG' },
      invocation: { ...digest.invocation, verb: 'ask' },
    });
    const ev = {
      teamId: 'T1',
      channel: 'C0ENG',
      ts: '1700000000.000100',
      emoji: 'memo',
      userId: 'U0MAYA',
    };
    expect(await w.engine.onReaction(w.orch, ev, w.sinkFor)).toBe(1);
    expect(await w.engine.onReaction(w.orch, ev, w.sinkFor)).toBe(0);
    expect(await w.engine.onReaction(w.orch, { ...ev, emoji: 'eyes' }, w.sinkFor)).toBe(0);
  });

  it('keyword triggers ignore bots and non-matching text', async () => {
    const w = world(['Runbook says…']);
    await w.config.setChannelPolicy('T1', 'C0ENG', {
      identity: 'user-preferred',
      serviceGrounds: [],
      serviceMayRead: true,
      autoApply: false,
    });
    await w.engine.create({
      ...digest,
      trigger: { kind: 'keyword', pattern: 'incident|sev[12]', channel: 'C0ENG' },
    });
    const base = {
      teamId: 'T1',
      channel: 'C0ENG',
      ts: '1700000000.000100',
      userId: 'U0MAYA',
      fromBot: false,
    };
    expect(
      await w.engine.onMessage(w.orch, { ...base, text: 'SEV1 in prod', fromBot: true }, w.sinkFor),
    ).toBe(0);
    expect(await w.engine.onMessage(w.orch, { ...base, text: 'lunch?' }, w.sinkFor)).toBe(0);
    expect(await w.engine.onMessage(w.orch, { ...base, text: 'SEV1 in prod' }, w.sinkFor)).toBe(1);
  });
});

describe('workflow steps', () => {
  it('returns answer/sources outputs and never actuates', async () => {
    const w = world(['A summary']);
    await w.config.setChannelPolicy('T1', 'C0ENG', {
      identity: 'user-preferred',
      serviceGrounds: [],
      serviceMayRead: true,
      autoApply: false,
    });
    const r = await runWorkflowStep(w.orch, 'ge_summarize', 'T1', 'U0ALEX', {
      channel_id: 'C0ENG',
      since: '7d',
      user_id: 'U0RUNNER',
    });
    expect(r).toMatchObject({
      ok: true,
      outputs: { answer: 'A summary', identity: 'as Gemini service' },
    });
    expect(w.surface.actuated).toHaveLength(0);
  });
  it('fails closed when the runner is not a member', async () => {
    const w = world(['x']);
    await w.config.setChannelPolicy('T1', 'C0ENG', {
      identity: 'user-preferred',
      serviceGrounds: [],
      serviceMayRead: true,
      autoApply: false,
    });
    const r = await runWorkflowStep(w.orch, 'ge_summarize', 'T1', 'U0ALEX', {
      channel_id: 'C0ENG',
      user_id: 'U0OUTSIDER',
    });
    expect(r.ok).toBe(false);
  });
});
