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
  | { type: 'done' };

/** Progress the runtime reports to a surface while a turn runs (rendered as Slack task cards). */
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface TaskUpdate {
  id: string;
  /** Fixed strings + counts only — never captured message content. */
  title: string;
  status: TaskStatus;
  details?: string;
}
