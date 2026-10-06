import type { Intent, Invocation, Origin, SourceRef } from '@ge-slack/contracts';
import type { Orchestrator, TurnSink } from '@ge-slack/runtime';

/**
 * Workflow Builder custom steps (`function_executed`). Steps are read-only building blocks: they
 * return text outputs (`answer`, `sources`) and let the workflow's own "Send a message" step post
 * them, so the workflow author — not Gemini — decides where output lands. `draft` therefore
 * produces text, never an actuation.
 */
export interface WorkflowStepInputs {
  /** Free-text prompt / instruction. */
  prompt?: string;
  /** Conversation to read (channel id). */
  channel_id?: string;
  /** Optional message ts to scope to a thread. */
  message_ts?: string;
  /** Window for channel scope, e.g. "24h", "7d". */
  since?: string;
}

export interface WorkflowStepOutputs {
  answer: string;
  sources: string;
  identity: string;
}

export type WorkflowStepResult =
  { ok: true; outputs: WorkflowStepOutputs } | { ok: false; error: string };

const STEP_VERB: Record<string, Intent> = {
  ge_ask: 'ask',
  ge_summarize: 'summarize',
  ge_draft: 'ask',
};

/** Collects a turn's answer instead of posting it. */
export class CollectingSink implements TurnSink {
  text = '';
  sources: SourceRef[] = [];
  identity = '';
  error?: string;
  async begin() {}
  async task() {}
  async token() {}
  async answer(a: Parameters<TurnSink['answer']>[0]) {
    this.text = a.text;
    this.sources = a.sources;
    this.identity = a.identity.kind === 'user' ? `as ${a.identity.label}` : 'as Gemini service';
  }
  async plan() {
    this.error = 'Workflow steps cannot apply changes; use a Send message step with the answer.';
  }
  async automationPlan() {
    this.error = 'Workflow steps cannot create automations.';
  }
  async connect(c: Parameters<TurnSink['connect']>[0]) {
    this.error = c.message;
  }
  async executing() {}
  async landed() {}
  async retire() {}
  async awaiting() {
    this.error = 'That agent needs a person to respond, so it can’t run in a workflow step.';
  }
  async notice(kind: Parameters<TurnSink['notice']>[0], text: string) {
    if (kind !== 'info') this.error = text.slice(0, 500);
    else if (!this.text) this.text = text;
  }
}

export async function runWorkflowStep(
  orch: Orchestrator,
  step: string,
  teamId: string,
  /**
   * The human Slack attests ran the workflow (`interactivity.interactor.id`). Free-form user
   * inputs are author-controlled and never used for authorization; without an attested human
   * the step fails closed (H2).
   */
  attestedUserId: string | undefined,
  inputs: WorkflowStepInputs,
): Promise<WorkflowStepResult> {
  const verb = STEP_VERB[step];
  if (!verb) return { ok: false, error: `Unknown step ${step}` };
  if (!attestedUserId || !/^[UW][A-Z0-9]+$/.test(attestedUserId)) {
    return {
      ok: false,
      error:
        'Gemini steps need a person to start the workflow (a link or button trigger), so access can be checked.',
    };
  }
  const instruction =
    step === 'ge_draft'
      ? `Draft a Slack message (text only, ready to post): ${inputs.prompt ?? ''}`
      : (inputs.prompt ?? '');
  const sinceMs = inputs.since ? parseSince(inputs.since) : undefined;
  const invocation: Invocation = {
    verb,
    inferredVerb: false,
    ...(inputs.channel_id
      ? {
          scope: inputs.message_ts
            ? { kind: 'thread' as const, channel: inputs.channel_id, ts: inputs.message_ts }
            : { kind: 'channel' as const, channel: inputs.channel_id },
        }
      : {}),
    grounds: [],
    people: [],
    from: [],
    instruction: instruction.slice(0, 4000),
    flags: { as: 'service', ...(sinceMs ? { sinceMs } : {}) },
  };
  const origin: Origin = {
    entry: 'workflow',
    teamId,
    // Membership checks run against the Slack-attested person who ran the workflow.
    userId: attestedUserId,
    ...(inputs.channel_id ? { channelId: inputs.channel_id } : {}),
  };
  const sink = new CollectingSink();
  await orch.run(invocation, origin, sink);
  if (sink.error) return { ok: false, error: sink.error };
  return {
    ok: true,
    outputs: {
      answer: sink.text.slice(0, 3900),
      sources: sink.sources
        .map((s, i) => `[${i + 1}] ${s.title}${s.uri ? ` ${s.uri}` : ''}`)
        .join('\n')
        .slice(0, 2000),
      identity: sink.identity,
    },
  };
}

function parseSince(text: string): number | undefined {
  const m = /^(\d{1,3})([hdw])$/.exec(text.trim());
  if (!m) return undefined;
  const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'h' | 'd' | 'w'];
  return Math.min(Number(m[1]) * unit, 30 * 86_400_000);
}
