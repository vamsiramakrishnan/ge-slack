import type { KeyValueStore } from '@ge-slack/identity';

/**
 * Firestore-backed KeyValueStore for production. Keys are hierarchical strings; they're stored as
 * documents in one collection with the key in a `k` field (prefix queries) and an optional
 * `expiresAt` (enable a Firestore TTL policy on it for cleanup; reads also honour it).
 *
 * The Firestore SDK is loaded lazily so local development and tests need no Google credentials.
 */
interface FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(v: Record<string, unknown>): Promise<unknown>;
      delete(): Promise<unknown>;
    };
    where(
      f: string,
      op: string,
      v: unknown,
    ): {
      where(
        f: string,
        op: string,
        v: unknown,
      ): {
        limit(n: number): { get(): Promise<{ docs: Array<{ data(): Record<string, unknown> }> }> };
      };
    };
  };
  runTransaction<T>(
    fn: (tx: {
      get(ref: unknown): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      delete(ref: unknown): void;
    }) => Promise<T>,
  ): Promise<T>;
}

export class FirestoreStore implements KeyValueStore {
  private constructor(
    private readonly db: FirestoreLike,
    private readonly collection: string,
    private readonly now: () => number,
  ) {}

  static async create(
    opts: { databaseId?: string; collection?: string; now?: () => number } = {},
  ): Promise<FirestoreStore> {
    const mod = (await import('@google-cloud/firestore')) as unknown as {
      Firestore: new (o: Record<string, unknown>) => FirestoreLike;
    };
    const db = new mod.Firestore({
      ...(opts.databaseId ? { databaseId: opts.databaseId } : {}),
      ignoreUndefinedProperties: true,
    });
    return new FirestoreStore(db, opts.collection ?? 'ge_slack_kv', opts.now ?? Date.now);
  }

  private ref(key: string) {
    return this.db.collection(this.collection).doc(encodeURIComponent(key));
  }

  private alive(d: Record<string, unknown> | undefined): boolean {
    if (!d) return false;
    const exp = d.expiresAt as { toMillis?: () => number } | number | undefined;
    const ms = typeof exp === 'number' ? exp : exp?.toMillis?.();
    return ms === undefined || ms > this.now();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const snap = await this.ref(key).get();
    const d = snap.data();
    return snap.exists && this.alive(d) ? (JSON.parse(String(d!.v)) as T) : undefined;
  }

  async set<T>(key: string, value: T, opts: { ttlMs?: number } = {}): Promise<void> {
    await this.ref(key).set({
      k: key,
      v: JSON.stringify(value),
      ...(opts.ttlMs !== undefined ? { expiresAt: new Date(this.now() + opts.ttlMs) } : {}),
    });
  }

  async delete(key: string): Promise<void> {
    await this.ref(key).delete();
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const q = await this.db
      .collection(this.collection)
      .where('k', '>=', prefix)
      .where('k', '<', `${prefix}\uf8ff`) // U+F8FF: highest BMP private-use char
      .limit(1000)
      .get();
    return q.docs
      .map((d) => d.data())
      .filter((d) => this.alive(d))
      .map((d) => ({ key: String(d.k), value: JSON.parse(String(d.v)) as T }));
  }

  /** Read-and-delete in a transaction: one-time tokens (OAuth state, plans) are consumed once. */
  async take<T>(key: string): Promise<T | undefined> {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      const d = snap.data();
      return this.alive(d) ? (JSON.parse(String(d!.v)) as T) : undefined;
    });
  }
}
