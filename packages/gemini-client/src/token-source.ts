/** Supplies a valid Google access token for one principal. Held in memory only. */
export interface TokenSource {
  getAccessToken(): Promise<string>;
  /** Force the next call to re-mint (e.g. after a 401). */
  invalidate?(): void;
}

/** Refresh this many seconds before expiry to avoid mid-flight 401s. */
export const EXPIRY_SKEW_SECONDS = 60;

/**
 * Memory cache with ge-msft `WifTokenClient` semantics: concurrent refreshes collapse into one
 * mint, and `invalidate()` bumps an epoch so an in-flight mint can't reinstate a stale token.
 */
export abstract class CachedTokenSource implements TokenSource {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;
  private epoch = 0;

  constructor(protected readonly now: () => number = Date.now) {}

  protected abstract mint(): Promise<{ token: string; expiresInSeconds: number }>;

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - EXPIRY_SKEW_SECONDS * 1000 > this.now()) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    const startEpoch = this.epoch;
    this.inflight = this.mint()
      .then(({ token, expiresInSeconds }) => {
        if (this.epoch === startEpoch) {
          this.cached = { token, expiresAtMs: this.now() + expiresInSeconds * 1000 };
        }
        return token;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.epoch += 1;
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
