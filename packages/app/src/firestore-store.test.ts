import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreStore } from './firestore-store.js';

const fake = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failure: undefined as unknown,
  writes: 0,
}));
vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    collection() {
      return {
        doc(id: string) {
          return {
            async create(value: unknown) {
              fake.writes++;
              if (fake.failure) throw fake.failure;
              if (fake.values.has(id))
                throw Object.assign(new Error('already exists'), { code: 6 });
              fake.values.set(id, value);
            },
          };
        },
      };
    }
  },
}));

beforeEach(() => {
  fake.values.clear();
  fake.failure = undefined;
  fake.writes = 0;
});
describe('Firestore atomic claims (SDK contract fake)', () => {
  it('uses native document create across separate adapters', async () => {
    const first = await FirestoreStore.create();
    const second = await FirestoreStore.create();
    const results = await Promise.all([
      first.create('claim/T1/change', { owner: 1 }),
      second.create('claim/T1/change', { owner: 2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.writes).toBe(2);
    expect(fake.values.size).toBe(1);
    expect(JSON.stringify([...fake.values.values()])).toContain('claim/T1/change');
  });
  it('does not turn storage failure into permission to dispatch', async () => {
    const store = await FirestoreStore.create();
    fake.failure = Object.assign(new Error('unavailable'), { code: 14 });
    await expect(store.create('claim/T1/change', {})).rejects.toThrow('unavailable');
    expect(fake.values.size).toBe(0);
  });
});
