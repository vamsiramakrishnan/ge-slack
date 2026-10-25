import { describe, expect, it, vi } from 'vitest';
import type { Automation } from '@ge-slack/contracts';
import { MemoryStore, type KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from '@ge-slack/runtime';
import { RecordingSink } from '@ge-slack/runtime/testing';
import { AutomationEngine } from './engine.js';

const definition: Omit<Automation, 'id' | 'createdAt'> = {
  teamId: 'T1',
  ownerId: 'U0ALEX',
  channelId: 'C0ENG',
  trigger: { kind: 'schedule', text: 'daily 9:00', cron: '0 9 * * *', timeZone: 'UTC' },
  invocation: {
    verb: 'summarize',
    inferredVerb: false,
    grounds: [],
    people: [],
    from: [],
    instruction: '',
    flags: {},
  },
  runAs: 'service',
  enabled: true,
};
const sinkFor = () => new RecordingSink();

function setup(kv: KeyValueStore = new MemoryStore()) {
  let now = new Date('2026-10-05T08:59:00Z');
  const clock = () => now;
  const engine = () => new AutomationEngine(kv, clock);
  const run = vi.fn(async () => undefined);
  const orch = { run } as unknown as Orchestrator;
  return {
    kv,
    clock,
    engine,
    run,
    orch,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

const reaction = {
  teamId: 'T1',
  channel: 'C0ENG',
  ts: '1700000000.000100',
  eventTs: '1700000001.000100',
  emoji: 'memo',
  userId: 'U0MAYA',
};
const message = {
  teamId: 'T1',
  channel: 'C0ENG',
  ts: '1700000000.000100',
  text: 'incident in prod',
  userId: 'U0MAYA',
  fromBot: false,
};

describe('durable automation occurrence claims', () => {
  it('admits a due slot only once across concurrent engine instances and the next slot separately', async () => {
    const w = setup();
    const first = w.engine();
    const a = await first.create(definition);
    w.setNow('2026-10-05T09:00:30Z');
    const runs = await Promise.all([
      first.tick(w.orch, 'T1', sinkFor),
      w.engine().tick(w.orch, 'T1', sinkFor),
    ]);
    expect(runs.flat()).toEqual([a.id]);
    expect(w.run).toHaveBeenCalledTimes(1);
    w.setNow('2026-10-06T09:00:30Z');
    await w.engine().tick(w.orch, 'T1', sinkFor);
    expect(w.run).toHaveBeenCalledTimes(2);
    expect(await w.kv.list(`automation-run/T1/${a.id}/`)).toHaveLength(2);
  });

  it('suppresses a replayed reaction across instances and restarts without merging distinct events', async () => {
    const w = setup();
    const first = w.engine();
    await first.create({
      ...definition,
      trigger: { kind: 'reaction', emoji: 'memo', channel: 'C0ENG' },
    });
    const results = await Promise.all([
      first.onReaction(w.orch, reaction, sinkFor),
      w.engine().onReaction(w.orch, reaction, sinkFor),
    ]);
    expect(results.reduce((a, b) => a + b)).toBe(1);
    w.setNow('2026-10-06T09:00:00Z');
    expect(await w.engine().onReaction(w.orch, reaction, sinkFor)).toBe(0);
    expect(
      await w.engine().onReaction(w.orch, { ...reaction, eventTs: '1700000500.000100' }, sinkFor),
    ).toBe(1);
    expect(w.run).toHaveBeenCalledTimes(2);
  });

  it('suppresses a replayed message across instances while allowing a different message', async () => {
    const w = setup();
    const first = w.engine();
    await first.create({
      ...definition,
      trigger: { kind: 'keyword', channel: 'C0ENG', pattern: 'incident' },
    });
    const results = await Promise.all([
      first.onMessage(w.orch, message, sinkFor),
      w.engine().onMessage(w.orch, message, sinkFor),
    ]);
    expect(results.reduce((a, b) => a + b)).toBe(1);
    w.setNow('2026-10-06T09:00:00Z');
    expect(await w.engine().onMessage(w.orch, message, sinkFor)).toBe(0);
    expect(
      await w.engine().onMessage(w.orch, { ...message, ts: '1700000500.000100' }, sinkFor),
    ).toBe(1);
    expect(w.run).toHaveBeenCalledTimes(2);
  });

  it('keeps deliberate owner Run now invocations separate', async () => {
    const w = setup();
    const first = w.engine();
    const a = await first.create(definition);
    await first.runNow(w.orch, 'T1', a.id, 'U0ALEX', sinkFor);
    await w.engine().runNow(w.orch, 'T1', a.id, 'U0ALEX', sinkFor);
    expect(w.run).toHaveBeenCalledTimes(2);
  });

  it('fails closed before invocation when atomic claims or reaction event identity are missing', async () => {
    const memory = new MemoryStore();
    const { get, set, delete: del, list, take } = memory;
    const legacy: KeyValueStore = {
      get: get.bind(memory),
      set: set.bind(memory),
      delete: del.bind(memory),
      list: list.bind(memory),
      take: take.bind(memory),
    };
    const w = setup(legacy);
    await w.engine().create(definition);
    w.setNow('2026-10-05T09:00:30Z');
    await expect(w.engine().tick(w.orch, 'T1', sinkFor)).rejects.toThrow('atomic create-if-absent');
    const reactionEngine = new AutomationEngine(memory, w.clock);
    await reactionEngine.create({ ...definition, trigger: { kind: 'reaction', emoji: 'memo' } });
    await expect(
      reactionEngine.onReaction(w.orch, { ...reaction, eventTs: undefined }, sinkFor),
    ).rejects.toThrow('stable event timestamp');
    expect(w.run).not.toHaveBeenCalled();
  });

  it('retains an uncertain occurrence after a crash between claiming and schedule advancement', async () => {
    const memory = new MemoryStore();
    const w = setup(memory);
    const first = w.engine();
    const a = await first.create(definition);
    const write = memory.set.bind(memory);
    let failAdvance = true;
    vi.spyOn(memory, 'set').mockImplementation(async (key, value, opts) => {
      if (key.startsWith('automation-next/') && failAdvance) {
        failAdvance = false;
        throw new Error('schedule checkpoint unavailable');
      }
      return write(key, value, opts);
    });
    w.setNow('2026-10-05T09:00:30Z');
    await expect(first.tick(w.orch, 'T1', sinkFor)).rejects.toThrow('checkpoint unavailable');
    expect(await w.engine().tick(w.orch, 'T1', sinkFor)).toEqual([]);
    expect(w.run).not.toHaveBeenCalled();
    const claims = await memory.list<{ state: string }>(`automation-run/T1/${a.id}/`);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.value.state).toBe('claimed');
  });

  it('preserves the attempt claim if the final checkpoint fails after task execution', async () => {
    const memory = new MemoryStore();
    const w = setup(memory);
    const first = w.engine();
    const a = await first.create({
      ...definition,
      trigger: { kind: 'keyword', channel: 'C0ENG', pattern: 'incident' },
    });
    const write = memory.set.bind(memory);
    vi.spyOn(memory, 'set').mockImplementation(async (key, value, opts) => {
      if (key.startsWith('automation-run/')) throw new Error('final checkpoint unavailable');
      return write(key, value, opts);
    });
    expect(await first.onMessage(w.orch, message, sinkFor)).toBe(1);
    expect(await w.engine().onMessage(w.orch, message, sinkFor)).toBe(0);
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(
      (await memory.list<{ state: string }>(`automation-run/T1/${a.id}/`))[0]!.value.state,
    ).toBe('claimed');
  });
});
