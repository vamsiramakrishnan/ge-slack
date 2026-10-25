import { z } from 'zod';

export const MAX_CAPTURE_MESSAGES = 200;
export const MAX_CAPTURE_BYTES = 256 * 1024;
export const MAX_CAPTURE_PAGES = 8;

/** Coverage is observation, never permission. Omission counts are known lower bounds. */
export const CaptureCoverageSchema = z.object({
  complete: z.boolean(),
  /** Native traversal direction; channel results may be rendered chronologically afterward. */
  order: z.enum(['oldest_first', 'newest_first', 'ranked', 'single']),
  pages: z.number().int().nonnegative(),
  capturedMessages: z.number().int().nonnegative(),
  /** UTF-8 JSON bytes of the returned context, excluding this coverage object. */
  capturedBytes: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES),
  omittedMessages: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
  reason: z
    .enum([
      'message_limit',
      'byte_limit',
      'page_limit',
      'cursor_cycle',
      'preview_only',
      'ranked_results',
    ])
    .optional(),
  /** Opaque continuation, usable only with the same admitted source. It grants no authority. */
  nextCursor: z.string().max(8192).optional(),
});
export type CaptureCoverage = z.infer<typeof CaptureCoverageSchema>;
