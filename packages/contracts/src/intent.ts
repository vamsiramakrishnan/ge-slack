import { z } from 'zod';

/**
 * The seven general verbs — identical to ge-msft's `IntentSchema` minus `visualize` (Slack has no
 * host chart object). Chat verbs are single-shot reads routed to `send`; the rest fan out to a
 * confirmable plan and go through the actuation gate (`runCommands`).
 */
export const IntentSchema = z.enum([
  'ask',
  'summarize',
  'explain',
  'rewrite',
  'review',
  'draft',
  'notes',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const CHAT_INTENTS: readonly Intent[] = ['ask', 'summarize', 'explain'];

export type IntentOutput = 'chat' | 'write' | 'annotation';

/** Output is derived from the intent — never declared independently (ge-msft `deriveOutput`). */
export function deriveOutput(intent: Intent): IntentOutput {
  if (CHAT_INTENTS.includes(intent)) return 'chat';
  if (intent === 'review' || intent === 'notes') return 'annotation';
  return 'write';
}

/** The route is total: anything that can write goes through the plan gate. */
export function isActuating(intent: Intent): boolean {
  return deriveOutput(intent) !== 'chat';
}

/** Control verbs never call the model. */
export const ControlVerbSchema = z.enum([
  'help',
  'connect',
  'disconnect',
  'whoami',
  'as',
  'sources',
  'automations',
  'undo',
]);
export type ControlVerb = z.infer<typeof ControlVerbSchema>;

export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  ask: 'Ask anything, grounded on your sources',
  summarize: 'Condense a thread, channel, or canvas',
  explain: 'Explain a message, decision, or log in plain language',
  rewrite: 'Rewrite with an instruction — staged for your review',
  review: 'Review a scope and post findings as threaded replies',
  draft: 'Draft a reply, announcement, canvas, or scheduled post',
  notes: 'Turn a discussion into notes and owned action items',
};

/** Friendly aliases users type. Mapping is explicit and small; unknown words become `ask`. */
export const INTENT_ALIASES: Record<string, Intent> = {
  summarise: 'summarize',
  tldr: 'summarize',
  catchup: 'summarize',
  'catch-up': 'summarize',
  recap: 'notes',
  minutes: 'notes',
  reply: 'draft',
  write: 'draft',
  compose: 'draft',
  edit: 'rewrite',
  check: 'review',
  why: 'explain',
  q: 'ask',
};
