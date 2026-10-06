import type { AnswerProvenance, SourceRef } from './provenance.js';

/** The provider-neutral stream the runtime consumes (ge-msft `SseEvent`, trimmed for Slack). */
export type AssistEvent =
  | { type: 'token'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'citation'; source: SourceRef }
  | { type: 'related-questions'; questions: string[] }
  | { type: 'policy'; verdict: 'block'; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'provenance'; payload: AnswerProvenance }
  /** Connectors that were skipped because this principal hasn't authorized them (untrusted names). */
  | { type: 'connector-auth'; connectors: string[] }
  /** A generated file (e.g. a Deep Research audio summary). Shown as a pointer, never fetched. */
  | { type: 'file'; mimeType: string; fileId: string }
  /** The agent stopped and needs the invoker: start a research plan, answer a question, authorize. */
  | { type: 'awaiting'; reason: AwaitingReason; handle: AgentHandle }
  | { type: 'done' };

export type AwaitingReason = 'research-plan' | 'input-required' | 'auth-required';

/** Where to continue an agent conversation: a streamAssist session, or an A2A context/task. */
export interface AgentHandle {
  session?: string;
  contextId?: string;
  taskId?: string;
}

/** Progress the runtime reports to a surface while a turn runs (rendered as Slack task cards). */
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface TaskUpdate {
  id: string;
  /** Fixed strings + counts only — never captured message content. */
  title: string;
  status: TaskStatus;
  details?: string;
}
