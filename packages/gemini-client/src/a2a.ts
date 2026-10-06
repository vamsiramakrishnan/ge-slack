import { randomUUID } from 'node:crypto';
import type { AnswerProvenance, AssistEvent } from '@ge-slack/contracts';
import { a2aStreamUrl, type GeminiClientConfig } from './config.js';
import { parseJsonArrayStream } from './json-stream.js';
import { contentHash } from './hash.js';
import { safeText, type TokenSource } from './token-source.js';
import { StreamAssistClient, type AssistTurn } from './stream-assist.js';

/**
 * Full-code (ADK / A2A) agents through the Gemini Enterprise A2A proxy (ADR-0002):
 * `POST v1/…/assistants/default_assistant/agents/{id}/a2a/v1/message:stream`.
 *
 * The proxy speaks A2A v1 JSON: `ROLE_USER` (not "user"), `content` (not `parts`), and a required
 * `messageId`. A task can stop in `TASK_STATE_INPUT_REQUIRED` or `TASK_STATE_AUTH_REQUIRED`; both
 * surface as an `awaiting` event so the invoker can answer or authorize, then continue the same
 * `contextId`/`taskId`.
 *
 * Never retried: the agent's own tools may have side effects, so a re-sent message could act
 * twice. Only a 401 (rejected before the agent ran) is re-sent once with a fresh token.
 * Engine Model Armor does not screen A2A agents; the runtime's output sanitizer still applies.
 */
export class A2aClient {
  constructor(
    private readonly config: GeminiClientConfig,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {}

  async *stream(tokens: TokenSource, turn: AssistTurn): AsyncGenerator<AssistEvent> {
    const agent = turn.agent;
    if (agent?.kind !== 'a2a') {
      yield { type: 'error', code: 'invalid_request', message: 'Not an A2A agent turn.' };
      return;
    }
    let res: Response;
    try {
      res = await this.post(tokens, turn, a2aStreamUrl(this.config, agent.agentId));
    } catch (err) {
      yield {
        type: 'error',
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }
    if (!res.ok || !res.body) {
      yield {
        type: 'error',
        code: `http_${res.status}`,
        message: (await safeText(res)) || `A2A agent failed (${res.status})`,
      };
      return;
    }

    let accumulated = '';
    const artifacts = new Map<string, string>();
    let contextId = agent.contextId;
    let taskId = agent.taskId;
    let state: string | undefined;
    const emit = (text: string): AssistEvent[] => {
      if (!text) return [];
      accumulated += text;
      return [{ type: 'token', text }];
    };

    try {
      for await (const raw of parseJsonArrayStream(res.body)) {
        const chunk = asRecord(raw);
        if (!chunk) continue;
        // `message:send` returns {message}|{task}; `message:stream` chunks add status/artifact updates.
        const message = asRecord(chunk.message) ?? asRecord(chunk.msg);
        const task = asRecord(chunk.task);
        const status = asRecord(chunk.statusUpdate);
        const artifact = asRecord(chunk.artifactUpdate);

        if (message) {
          contextId = str(message.contextId) ?? contextId;
          taskId = str(message.taskId) ?? taskId;
          if (str(message.role) !== 'ROLE_USER') yield* emit(partsText(message));
        }
        if (task) {
          contextId = str(task.contextId) ?? contextId;
          taskId = str(task.id) ?? taskId;
          const st = asRecord(task.status);
          state = str(st?.state) ?? state;
          // A task snapshot carries its artifacts whole; only take text we haven't streamed.
          for (const a of arr(task.artifacts)) yield* emit(artifactDelta(asRecord(a), artifacts));
          const statusMsg = asRecord(st?.message);
          if (statusMsg && isWaiting(state)) yield* emit(partsText(statusMsg));
        }
        if (status) {
          contextId = str(status.contextId) ?? contextId;
          taskId = str(status.taskId) ?? taskId;
          const st = asRecord(status.status);
          state = str(st?.state) ?? state;
          const statusMsg = asRecord(st?.message);
          const text = statusMsg ? partsText(statusMsg) : '';
          if (text && isWaiting(state)) yield* emit(text);
          else if (text) {
            const activity = text.replace(/\s+/g, ' ').trim().slice(0, 160);
            if (activity) yield { type: 'activity', text: activity };
          }
        }
        if (artifact) {
          contextId = str(artifact.contextId) ?? contextId;
          taskId = str(artifact.taskId) ?? taskId;
          yield* emit(
            artifactDelta(asRecord(artifact.artifact), artifacts, artifact.append === true),
          );
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        code: 'stream_interrupted',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    if (state && /FAILED|REJECTED|CANCEL/.test(state)) {
      yield { type: 'error', code: 'agent_failed', message: `The agent stopped (${state}).` };
      return;
    }
    const payload: AnswerProvenance = {
      agentId: `gemini-enterprise:${this.config.assistant.engine}/a2a:${agent.agentId}`,
      identity: turn.identity,
      timestamp: new Date().toISOString(),
      sources: [],
      contentHash: await contentHash(accumulated),
      ...(contextId ? { sessionId: contextId } : {}),
    };
    yield { type: 'provenance', payload };
    const handle = {
      ...(contextId ? { contextId } : {}),
      ...(taskId ? { taskId } : {}),
    };
    if (state?.endsWith('INPUT_REQUIRED')) {
      yield { type: 'awaiting', reason: 'input-required', handle };
    } else if (state?.endsWith('AUTH_REQUIRED')) {
      yield { type: 'awaiting', reason: 'auth-required', handle };
    }
    yield { type: 'done' };
  }

  private async post(tokens: TokenSource, turn: AssistTurn, url: string): Promise<Response> {
    const agent = turn.agent!;
    const body = JSON.stringify({
      message: {
        role: 'ROLE_USER',
        content: [{ text: turn.text || ' ' }],
        messageId: randomUUID(),
        ...(agent.contextId ? { contextId: agent.contextId } : {}),
        ...(agent.taskId ? { taskId: agent.taskId } : {}),
      },
    });
    const send = async (): Promise<Response> =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokens.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body,
        ...(turn.signal ? { signal: turn.signal } : {}),
      });
    let res = await send();
    if (res.status === 401 && tokens.invalidate) {
      tokens.invalidate();
      res = await send();
    }
    return res;
  }
}

/**
 * One `stream()` for every route: A2A agents go through the proxy, everything else (default
 * assistant, skills, Workflow Builder chat agents, Deep Research) through `:streamAssist`.
 */
export class GeminiEnterpriseClient {
  constructor(
    private readonly assist: StreamAssistClient,
    private readonly a2a: A2aClient,
  ) {}

  stream(tokens: TokenSource, turn: AssistTurn): AsyncGenerator<AssistEvent> {
    return turn.agent?.kind === 'a2a'
      ? this.a2a.stream(tokens, turn)
      : this.assist.stream(tokens, turn);
  }
}

function isWaiting(state: string | undefined): boolean {
  return Boolean(state && /INPUT_REQUIRED|AUTH_REQUIRED/.test(state));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Text of a message or artifact: A2A v1 uses `content`, older payloads `parts`. */
function partsText(m: Record<string, unknown>): string {
  return [...arr(m.content), ...arr(m.parts)].map((p) => str(asRecord(p)?.text) ?? '').join('');
}

/**
 * New text of an artifact: an `append` chunk carries only the new part; otherwise it is a
 * snapshot, of which we emit what we haven't streamed yet.
 */
function artifactDelta(
  a: Record<string, unknown> | undefined,
  seen: Map<string, string>,
  append = false,
): string {
  if (!a) return '';
  const id = str(a.artifactId) ?? str(a.name) ?? '_';
  const text = partsText(a);
  const prev = seen.get(id) ?? '';
  if (append) {
    seen.set(id, prev + text);
    return text;
  }
  seen.set(id, text);
  return text.startsWith(prev) ? text.slice(prev.length) : text;
}
