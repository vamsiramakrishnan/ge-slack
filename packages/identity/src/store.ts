/**
 * Minimal durable key-value port. Production uses Firestore (see `app`); tests and local dev use
 * the in-memory store. Values are JSON; secrets are sealed by the vault *before* they get here.
 */
export interface KeyValueStore {
  readonly durable?: boolean;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys + values under a prefix (bounded by the caller's key design). */
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  /** Atomic create-if-absent. Required for write claims; callers must never emulate with get/set. */
  create?<T>(key: string, value: T): Promise<boolean>;
  /** Atomically read-and-delete (one-time tokens such as OAuth `state`). */
  take<T>(key: string): Promise<T | undefined>;
}

export class MemoryStore implements KeyValueStore {
  readonly durable = false;
  private readonly data = new Map<string, { value: unknown; expiresAt?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.live(key);
    return e ? (structuredClone(e.value) as T) : undefined;
  }

  async set<T>(key: string, value: T, opts: { ttlMs?: number } = {}): Promise<void> {
    this.data.set(key, {
      value: structuredClone(value),
      ...(opts.ttlMs !== undefined ? { expiresAt: this.now() + opts.ttlMs } : {}),
    });
  }

  async create<T>(key: string, value: T): Promise<boolean> {
    // No await between the check and insertion: concurrent callers share one atomic map step.
    if (this.live(key)) return false;
    this.data.set(key, { value: structuredClone(value) });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const out: Array<{ key: string; value: T }> = [];
    for (const key of [...this.data.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const e = this.live(key);
      if (e) out.push({ key, value: structuredClone(e.value) as T });
    }
    return out;
  }

  async take<T>(key: string): Promise<T | undefined> {
    const e = this.live(key);
    this.data.delete(key);
    return e ? (e.value as T) : undefined;
  }
}
