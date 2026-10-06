/**
 * The narrow Slack Web API port the bridge depends on. The app adapts `@slack/web-api`'s
 * `WebClient.apiCall` to it; tests use a recording fake. Keeping the bridge free of the SDK keeps
 * every Slack call visible and testable in one place.
 */
export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [k: string]: unknown;
}

export interface SlackApi {
  call(method: string, args: Record<string, unknown>): Promise<SlackApiResponse>;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** Call and throw on `ok: false` (the SDK may also throw; both surface as SlackApiError-like). */
export async function must(
  api: SlackApi,
  method: string,
  args: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const r = await api.call(method, args);
  if (!r.ok) throw new SlackApiError(method, r.error ?? 'unknown_error');
  return r;
}

/** Map an SDK error (WebAPIPlatformError has `data.error`) or ours to a Slack error code. */
export function slackErrorCode(err: unknown): string | undefined {
  if (err instanceof SlackApiError) return err.code;
  const data = (err as { data?: { error?: unknown } })?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}
