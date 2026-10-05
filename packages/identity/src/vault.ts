import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals refresh tokens at rest (ADR-0001 §3). AES-256-GCM with the `(team, user)` pair as AAD so a
 * sealed blob copied into another user's record fails to open. Production wraps the data key with
 * Cloud KMS (`KeyProvider`); dev supplies a 32-byte base64 key in `GE_SLACK_VAULT_KEY`.
 */
export interface KeyProvider {
  /** Current key id + 32-byte key used for new seals. */
  current(): Promise<{ keyId: string; key: Buffer }>;
  /** Resolve a key by id (supports rotation: old blobs stay readable). */
  byId(keyId: string): Promise<Buffer | undefined>;
}

export class StaticKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly currentId: string,
    keys: Record<string, string>,
  ) {
    this.keys = new Map(Object.entries(keys).map(([id, b64]) => [id, Buffer.from(b64, 'base64')]));
    for (const [id, k] of this.keys) {
      if (k.length !== 32) throw new Error(`vault key ${id} must be 32 bytes (base64)`);
    }
    if (!this.keys.has(currentId)) throw new Error(`vault key ${currentId} missing`);
  }
  async current() {
    return { keyId: this.currentId, key: this.keys.get(this.currentId)! };
  }
  async byId(keyId: string) {
    return this.keys.get(keyId);
  }
}

export interface SealedSecret {
  v: 1;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

export class TokenVault {
  constructor(private readonly keys: KeyProvider) {}

  async seal(plaintext: string, aad: string): Promise<SealedSecret> {
    const { keyId, key } = await this.keys.current();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: 1,
      keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  /** Throws on a wrong AAD, tampered blob, or unknown key — callers treat that as "not linked". */
  async open(sealed: SealedSecret, aad: string): Promise<string> {
    const key = await this.keys.byId(sealed.keyId);
    if (!key) throw new Error('vault: unknown key id');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export function userAad(teamId: string, slackUserId: string): string {
  return `ge-slack:identity:${teamId}:${slackUserId}`;
}

/**
 * Envelope encryption with Cloud KMS (production). Data keys are stored only as KMS ciphertext;
 * the bot unwraps them at boot with its runtime identity (`cloudkms.cryptoKeyVersions.useToDecrypt`
 * on that one key) and holds plaintext keys in memory. Reading the env or Firestore alone is not
 * enough to decrypt refresh tokens (M9).
 */
export class CloudKmsKeyProvider implements KeyProvider {
  private keys: Map<string, Buffer> | undefined;

  constructor(
    private readonly kmsKeyName: string,
    private readonly currentId: string,
    /** keyId → base64 KMS ciphertext of a 32-byte data key. */
    private readonly wrapped: Record<string, string>,
    private readonly tokens: { getAccessToken(): Promise<string> },
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {
    if (
      !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(kmsKeyName)
    ) {
      throw new Error('GE_SLACK_KMS_KEY must be a Cloud KMS cryptoKey resource name');
    }
    if (!wrapped[currentId]) throw new Error(`wrapped vault key ${currentId} missing`);
  }

  private async load(): Promise<Map<string, Buffer>> {
    if (this.keys) return this.keys;
    const out = new Map<string, Buffer>();
    const token = await this.tokens.getAccessToken();
    for (const [id, ciphertext] of Object.entries(this.wrapped)) {
      const res = await this.fetchImpl(
        `https://cloudkms.googleapis.com/v1/${this.kmsKeyName}:decrypt`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ciphertext }),
        },
      );
      if (!res.ok) throw new Error(`KMS decrypt failed for vault key ${id} (${res.status})`);
      const { plaintext } = (await res.json()) as { plaintext?: string };
      const key = Buffer.from(plaintext ?? '', 'base64');
      if (key.length !== 32) throw new Error(`vault key ${id} must unwrap to 32 bytes`);
      out.set(id, key);
    }
    this.keys = out;
    return out;
  }

  async current() {
    return { keyId: this.currentId, key: (await this.load()).get(this.currentId)! };
  }

  async byId(keyId: string) {
    return (await this.load()).get(keyId);
  }
}
