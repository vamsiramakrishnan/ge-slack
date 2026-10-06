import { randomBytes } from 'node:crypto';
import type { Origin } from '@ge-slack/contracts';
import type { KeyValueStore } from '@ge-slack/identity';
import type { Orchestrator } from './orchestrator.js';
import type { TurnSink } from './ports.js';

/**
 * Background jobs (EXPERIENCE §10): long agent runs (Deep Research, A2A tasks) are tracked so the
 * invoker can see and cancel them from anywhere, get a DM when a long one finishes, and never see
 * a dead run looking alive.
 *
 * The run itself stays in the process that started it (Cloud Run keeps CPU after the response).
 * Cross-instance control goes through the store: the runner heartbeats every few seconds and
 * picks up `cancelRequested`; a run whose heartbeat stops is reported as interrupted.
 */
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRecord {
  id: string;
  teamId: string;
  invokerId: string;
  /** Fixed label ("Deep Research · #eng"), never captured content. */
  title: string;
  channel?: string;
  threadTs?: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  heartbeatAt: string;
  cancelRequested?: boolean;
}

export const JOB_HEARTBEAT_MS = 5_000;
export const JOB_STALE_MS = 60_000;
/** Runs longer than this also DM the invoker when they finish. */
export const JOB_NOTIFY_AFTER_MS = 60_000;
const JOB_RETAIN_MS = 7 * 86_400_000;

export class JobStore {
  constructor(private readonly kv: KeyValueStore) {}
  save(j: JobRecord) {
    return this.kv.set(`job/${j.teamId}/${j.id}`, j, { ttlMs: JOB_RETAIN_MS });
  }
  get(teamId: string, id: string) {
    return this.kv.get<JobRecord>(`job/${teamId}/${id}`);
  }
  async forUser(teamId: string, userId: string, now: number): Promise<JobRecord[]> {
    const rows = await this.kv.list<JobRecord>(`job/${teamId}/`);
    return rows
      .map((r) => r.value)
      .filter((j) => j.invokerId === userId)
      .map((j) => withLiveness(j, now))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

/** A "running" job whose heartbeat stopped was interrupted (restart, crash, scale-in). */
export function withLiveness(j: JobRecord, now: number): JobRecord {
  if (j.status === 'running' && now - Date.parse(j.heartbeatAt) > JOB_STALE_MS) {
    return { ...j, status: 'interrupted' };
  }
  return j;
}

/** In-process controllers, so a cancel on the same instance is immediate. */
const local = new Map<string, AbortController>();

export async function runAsJob(
  orch: Orchestrator,
  origin: Origin,
  title: string,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<boolean>,
): Promise<void> {
  const jobs = orch.deps.jobs;
  if (!jobs || !orch.deps.features?.has('jobs')) {
    await run(outer ?? new AbortController().signal);
    return;
  }
  const now = () => new Date().toISOString();
  const ac = new AbortController();
  outer?.addEventListener('abort', () => ac.abort(), { once: true });
  const job: JobRecord = {
    id: randomBytes(8).toString('hex'),
    teamId: origin.teamId,
    invokerId: origin.userId,
    title,
    ...(origin.channelId ? { channel: origin.channelId } : {}),
    ...((origin.threadTs ?? origin.messageTs)
      ? { threadTs: origin.threadTs ?? origin.messageTs }
      : {}),
    status: 'running',
    startedAt: now(),
    heartbeatAt: now(),
  };
  await jobs.save(job);
  local.set(job.id, ac);
  orch.observe(origin.teamId, { kind: 'job', outcome: 'started' });
  let finished = false;
  let inflight: Promise<void> | undefined;
  const beat = setInterval(() => {
    if (inflight) return;
    inflight = (async () => {
      const cur = await jobs.get(job.teamId, job.id);
      if (cur?.cancelRequested) ac.abort();
      // Never overwrite the final status written below.
      if (finished) return;
      await jobs.save({
        ...job,
        heartbeatAt: now(),
        ...(cur?.cancelRequested ? { cancelRequested: true } : {}),
      });
    })()
      .catch(() => undefined)
      .finally(() => {
        inflight = undefined;
      });
  }, JOB_HEARTBEAT_MS);
  beat.unref?.();
  let status: JobStatus = 'failed';
  try {
    const ok = await run(ac.signal);
    status = ac.signal.aborted ? 'cancelled' : ok ? 'done' : 'failed';
  } finally {
    finished = true;
    clearInterval(beat);
    await inflight;
    local.delete(job.id);
    const ended = new Date();
    await jobs.save({
      ...job,
      status,
      endedAt: ended.toISOString(),
      heartbeatAt: ended.toISOString(),
    });
    orch.observe(origin.teamId, { kind: 'job', outcome: status });
    const tookMs = ended.getTime() - Date.parse(job.startedAt);
    if (status === 'done' && tookMs > JOB_NOTIFY_AFTER_MS) {
      await orch.deps.surface
        .notifyUser(origin.userId, {
          text: `✦ *${title}* finished.`,
          ...(job.channel && job.threadTs
            ? { link: { channel: job.channel, ts: job.threadTs } }
            : {}),
        })
        .catch(() => undefined);
    }
  }
}

/** Cancel a job — invoker only. Works from any instance (the runner polls the store). */
export async function cancelJob(
  orch: Orchestrator,
  teamId: string,
  id: string,
  userId: string,
  sink: TurnSink,
): Promise<void> {
  const jobs = orch.deps.jobs;
  const j = jobs ? await jobs.get(teamId, id) : undefined;
  if (!jobs || !j) {
    await sink.notice('info', 'That job is gone.');
    return;
  }
  if (j.invokerId !== userId) {
    await sink.notice('denied', `Only <@${j.invokerId}> can cancel this job.`);
    return;
  }
  const live = withLiveness(j, Date.now());
  if (live.status !== 'running') {
    await sink.notice(
      'info',
      `That job already ${live.status === 'done' ? 'finished' : `is ${live.status}`}.`,
    );
    return;
  }
  await jobs.save({ ...j, cancelRequested: true });
  local.get(id)?.abort();
  await sink.notice('info', `Cancelling *${j.title}*…`);
}

/** `/gemini jobs`: your running and recent jobs. */
export async function showJobs(orch: Orchestrator, origin: Origin, sink: TurnSink): Promise<void> {
  if (!orch.deps.jobs || !orch.deps.features?.has('jobs')) {
    await sink.notice('info', 'Background jobs are switched off for this workspace.');
    return;
  }
  const list = (await orch.deps.jobs.forUser(origin.teamId, origin.userId, Date.now())).slice(
    0,
    10,
  );
  if (!list.length) {
    await sink.notice('info', 'No jobs yet. Deep Research runs and A2A agent tasks show up here.');
    return;
  }
  const icon: Record<JobStatus, string> = {
    running: '⏳',
    done: '✅',
    failed: '❌',
    cancelled: '⏹️',
    interrupted: '⚠️',
  };
  await sink.notice(
    'info',
    [
      '*Your Gemini jobs* (App Home lists running ones with Cancel)',
      ...list.map(
        (j) =>
          `${icon[j.status]} ${j.title} · ${j.status} · started ${j.startedAt.slice(0, 16).replace('T', ' ')} UTC`,
      ),
    ].join('\n'),
  );
}
