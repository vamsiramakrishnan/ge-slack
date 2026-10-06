import {
  collectionResourceName,
  discoveryEngineHost,
  proxyBase,
  type GeminiClientConfig,
} from './config.js';
import { safeText, type TokenSource } from './token-source.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type Failure = { ok: false; code: string; message: string; uncertain?: boolean };

/** `uncertain`: the call may have run (5xx / 408 / timeout / unreadable reply after dispatch). */
export type McpCallResult = { ok: true; text: string } | Failure;

/**
 * Connector tools through Gemini Enterprise: `POST v1alpha/{collection}/dataConnector:
 * invokeConnectorMcp` with an MCP request (`tools/list`, `tools/call`). The call runs under the
 * caller's identity and their connector authorization in Gemini Enterprise.
 *
 * Undocumented in the guides (schema only, ADR-0002 probe 6). Never retried: `tools/call` acts in
 * another system, so a retried call could act twice. A 401 is re-sent once only for `tools/list`:
 * on `tools/call` it may come from the connector after the fact, so the person re-authorizes.
 */
export class ConnectorMcpClient {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {}

  async listTools(tokens: TokenSource, collection: string): Promise<McpTool[]> {
    const r = await this.invoke(tokens, collection, 'tools/list', {});
    if (!r.ok) throw new Error(`tools/list failed (${r.code})`);
    const tools = (r.result as { tools?: unknown }).tools;
    return (Array.isArray(tools) ? tools : [])
      .map((t) => t as Record<string, unknown>)
      .filter((t) => typeof t.name === 'string')
      .map((t) => ({
        name: String(t.name),
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      }));
  }

  async callTool(
    tokens: TokenSource,
    collection: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const r = await this.invoke(tokens, collection, 'tools/call', { name, arguments: args });
    if (!r.ok) return r;
    const result = r.result as { content?: unknown; isError?: unknown };
    const text = (Array.isArray(result.content) ? result.content : [])
      .map((c) => c as { type?: string; text?: unknown })
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => String(c.text))
      .join('\n');
    if (result.isError === true) {
      return { ok: false, code: 'tool_error', message: text || 'The connector reported an error.' };
    }
    return { ok: true, text };
  }

  private url(collection: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(collection)) throw new Error('Invalid connector collection');
    if (this.config.proxyUrl)
      return `${proxyBase(this.config.proxyUrl)}/connectors/${collection}/mcp`;
    const base = collectionResourceName({ ...this.config.assistant, collection });
    return `${discoveryEngineHost(this.config.assistant.location)}/v1alpha/${base}/dataConnector:invokeConnectorMcp`;
  }

  private async invoke(
    tokens: TokenSource,
    collection: string,
    method: 'tools/list' | 'tools/call',
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | Failure> {
    const a = this.config.assistant;
    const engine = `${collectionResourceName(a)}/engines/${a.engine}`;
    const body = JSON.stringify({ method, params, engine });
    const url = this.url(collection);
    const send = async () =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokens.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    const acting = method === 'tools/call';
    const unsure = acting ? { uncertain: true } : {};
    let res: Response;
    try {
      res = await send();
      if (res.status === 401 && !acting && tokens.invalidate) {
        tokens.invalidate();
        res = await send();
      }
    } catch (err) {
      // Timed out or dropped after the request left: a tools/call may have run.
      return {
        ok: false,
        code: 'network',
        message: err instanceof Error ? err.name : 'network',
        ...unsure,
      };
    }
    if (!res.ok) {
      const maybeRan = res.status >= 500 || res.status === 408 || res.status === 499;
      return {
        ok: false,
        code: `http_${res.status}`,
        message: (await safeText(res)).slice(0, 300),
        ...(maybeRan ? unsure : {}),
      };
    }
    let json: { result?: unknown; error?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { ok: false, code: 'bad_reply', message: 'The reply could not be read.', ...unsure };
    }
    if (json.error) {
      const e = json.error as { code?: unknown; message?: unknown };
      return {
        ok: false,
        code: `mcp_${String(e.code ?? 'error')
          .replace(/[^\w-]/g, '')
          .slice(0, 20)}`,
        message: String(e.message ?? 'MCP error').slice(0, 300),
      };
    }
    return { ok: true, result: json.result ?? {} };
  }
}
