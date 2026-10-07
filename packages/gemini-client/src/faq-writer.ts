import { discoveryEngineHost, proxyBase, type GeminiClientConfig } from './config.js';
import { safeText, type TokenSource } from './token-source.js';

const DATA_STORE_RE =
  /^projects\/[^/\s]+\/locations\/([a-z0-9-]+)\/collections\/[\w-]{1,128}\/dataStores\/[\w-]{1,128}$/;
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface FaqDocument {
  question: string;
  answer: string;
  sources: string[];
  /** Provenance kept on the document (Slack ids and the change id; no tokens). */
  drafter: string;
  approver: string;
  changeId: string;
  createdAt: string;
}

/**
 * Thread → FAQ (ADR-0003 §5): one document per approved FAQ in a dedicated data store, written by
 * the curator service account only (`roles/discoveryengine.editor` on that data store).
 * `documents.create` with the request id as the document id (so a retry can't duplicate), and
 * `documents.delete` to undo.
 */
export class FaqWriter {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly dataStore: string,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {
    const m = DATA_STORE_RE.exec(dataStore);
    if (!m) throw new Error('Invalid FAQ data store name');
    if (m[1] !== config.assistant.location) {
      throw new Error('The FAQ data store must be in GE_LOCATION (residency pin)');
    }
  }

  private docs(): string {
    const host = this.config.proxyUrl
      ? proxyBase(this.config.proxyUrl)
      : discoveryEngineHost(this.config.assistant.location);
    return `${host}/v1alpha/${this.dataStore}/branches/default_branch/documents`;
  }

  async create(
    tokens: TokenSource,
    id: string,
    doc: FaqDocument,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (!DOC_ID_RE.test(id)) return { ok: false, code: 'bad_id' };
    const text = `Q: ${doc.question}\n\nA: ${doc.answer}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.docs()}?documentId=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokens.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          structData: { ...doc, sources: doc.sources.slice(0, 10), kind: 'slack-faq' },
          content: {
            mimeType: 'text/plain',
            rawBytes: Buffer.from(text, 'utf8').toString('base64'),
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { ok: false, code: 'network' };
    }
    if (res.status === 409) return { ok: true }; // already published under this id
    if (!res.ok) {
      await safeText(res);
      return { ok: false, code: `http_${res.status}` };
    }
    return { ok: true };
  }

  async remove(
    tokens: TokenSource,
    id: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (!DOC_ID_RE.test(id)) return { ok: false, code: 'bad_id' };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.docs()}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await tokens.getAccessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { ok: false, code: 'network' };
    }
    if (res.status === 404) return { ok: true };
    if (!res.ok) {
      await safeText(res);
      return { ok: false, code: `http_${res.status}` };
    }
    return { ok: true };
  }
}

export function isDataStoreName(s: string): boolean {
  return DATA_STORE_RE.test(s);
}
