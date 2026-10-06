import { z } from 'zod';

/**
 * Channel memory (EXPERIENCE §10): notes people add on purpose, visible and editable, used to
 * ground turns in that channel as data. Never learned silently from conversation.
 */
export const MEMORY_LIMITS = {
  /** All of them fit on one `/gemini memory` card — nothing that grounds answers is hidden. */
  notesPerChannel: 45,
  chars: 500,
  /** Notes expire; a team re-adds what still matters (security review H1). */
  ttlDays: 90,
  /** Adds per person per channel per hour (bounds remember/forget churn). */
  addsPerHour: 20,
} as const;

export const ChannelNoteSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,32}$/),
  channel: z.string(),
  text: z.string().min(1).max(MEMORY_LIMITS.chars),
  /** Who added it. */
  author: z.string(),
  at: z.string(),
  /** The message it was remembered from ("Remember this"). */
  permalink: z.string().url().optional(),
  /** Author of that message, when different from `author`. */
  sourceUser: z.string().optional(),
  /** Tombstone: forgotten notes stay listed (who/when) for a while, but never ground answers. */
  forgottenBy: z.string().optional(),
  forgottenAt: z.string().optional(),
});
export type ChannelNote = z.infer<typeof ChannelNoteSchema>;

export type NoteText = { ok: true; text: string } | { ok: false; error: string };

/**
 * Clean a note: one paragraph, no control or bidi characters, no broadcast mentions, bounded.
 * Notes are rendered back into Slack (escaped) and into prompts (neutralized), so this is about
 * keeping them legible, not about trust.
 */
export function cleanNoteText(raw: string): NoteText {
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? ' ' : ''))
    .replace(/<!(channel|here|everyone|subteam\^[A-Z0-9]+)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, error: 'That note is empty.' };
  if (text.length > MEMORY_LIMITS.chars) {
    return {
      ok: false,
      error: `Notes are limited to ${MEMORY_LIMITS.chars} characters (this one has ${text.length}).`,
    };
  }
  return { ok: true, text };
}
