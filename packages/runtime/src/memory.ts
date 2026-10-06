import { randomBytes } from 'node:crypto';
import { MEMORY_LIMITS, cleanNoteText, type ChannelNote, type Origin } from '@ge-slack/contracts';
import type { Orchestrator } from './orchestrator.js';
import type { TurnSink } from './ports.js';

/**
 * Channel memory operations (EXPERIENCE §10). Every operation requires the feature, a channel,
 * and that the person is a member of it — reading notes is reading the channel.
 */

async function gate(
  orch: Orchestrator,
  origin: Origin,
  sink: TurnSink,
  change = false,
): Promise<string | null> {
  if (!orch.deps.features?.has('memory')) {
    await sink.notice('info', 'Channel memory is switched off for this workspace.');
    return null;
  }
  const channel = origin.channelId;
  if (!channel) {
    await sink.notice('error', 'Channel memory works in a channel — run this there.');
    return null;
  }
  if (!(await orch.deps.surface.isMember(channel, origin.userId))) {
    await sink.notice('denied', `You're not a member of <#${channel}>.`);
    return null;
  }
  // Notes ground everyone's answers in the channel: only full members of this workspace may
  // change them, never guests or people from another organization (security review H1).
  if (change && (await orch.deps.surface.isGuest(origin.userId))) {
    await sink.notice('denied', "Guests and external members can't change channel memory.");
    return null;
  }
  return channel;
}

export async function rememberNote(
  orch: Orchestrator,
  origin: Origin,
  raw: string,
  sink: TurnSink,
  from?: { permalink?: string; sourceUser?: string },
): Promise<void> {
  const channel = await gate(orch, origin, sink, true);
  if (!channel) return;
  const cleaned = cleanNoteText(raw);
  if (!cleaned.ok) {
    await sink.notice('error', cleaned.error);
    return;
  }
  const all = await orch.deps.stores.notes(origin.teamId, channel);
  const live = all.filter((n) => !n.forgottenAt);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  if (
    all.filter((n) => n.author === origin.userId && n.at > hourAgo).length >=
    MEMORY_LIMITS.addsPerHour
  ) {
    await sink.notice('error', 'That’s a lot of notes in an hour — try again later.');
    return;
  }
  if (live.length >= MEMORY_LIMITS.notesPerChannel) {
    await sink.notice(
      'error',
      `<#${channel}> already has ${MEMORY_LIMITS.notesPerChannel} notes. Forget one first (\`/gemini memory\`).`,
    );
    return;
  }
  const note: ChannelNote = {
    id: randomBytes(8).toString('hex'),
    channel,
    text: cleaned.text,
    author: origin.userId,
    at: new Date().toISOString(),
    ...(from?.permalink ? { permalink: from.permalink } : {}),
    ...(from?.sourceUser && from.sourceUser !== origin.userId
      ? { sourceUser: from.sourceUser }
      : {}),
  };
  await orch.deps.stores.saveNote(origin.teamId, note);
  orch.observe(origin.teamId, { kind: 'memory', outcome: 'added' });
  await sink.notice(
    'info',
    `📌 Remembered for <#${channel}> (note ${live.length + 1} of ${MEMORY_LIMITS.notesPerChannel}). Answers in this channel will use it. \`/gemini memory\` to see or forget notes.`,
  );
}

export async function showMemory(orch: Orchestrator, origin: Origin, sink: TurnSink) {
  const channel = await gate(orch, origin, sink);
  if (!channel) return;
  const all = await orch.deps.stores.notes(origin.teamId, channel);
  const live = all.filter((n) => !n.forgottenAt);
  const gone = all
    .filter((n) => n.forgottenAt)
    .sort((a, b) => (b.forgottenAt ?? '').localeCompare(a.forgottenAt ?? ''));
  await sink.memory({
    channel,
    notes: live.map((n, i) => ({
      n: i + 1,
      id: n.id,
      text: n.text,
      author: n.author,
      at: n.at,
      ...(n.permalink ? { permalink: n.permalink } : {}),
      ...(n.sourceUser ? { sourceUser: n.sourceUser } : {}),
    })),
    forgotten: {
      count: gone.length,
      ...(gone[0]?.forgottenBy ? { lastBy: gone[0].forgottenBy } : {}),
      ...(gone[0]?.forgottenAt ? { lastAt: gone[0].forgottenAt } : {}),
    },
    limit: MEMORY_LIMITS.notesPerChannel,
  });
}

/** Forget by list number (`/gemini forget 3`) or by id (the Forget button). */
export async function forgetNote(
  orch: Orchestrator,
  origin: Origin,
  which: { n: number } | { id: string },
  sink: TurnSink,
): Promise<void> {
  const channel = await gate(orch, origin, sink, true);
  if (!channel) return;
  const live = (await orch.deps.stores.notes(origin.teamId, channel)).filter((n) => !n.forgottenAt);
  const note = 'n' in which ? live[which.n - 1] : live.find((n) => n.id === which.id);
  if (!note) {
    await sink.notice(
      'info',
      'That note is gone already — `/gemini memory` shows the current list.',
    );
    return;
  }
  await orch.deps.stores.saveNote(origin.teamId, {
    ...note,
    forgottenBy: origin.userId,
    forgottenAt: new Date().toISOString(),
  });
  orch.observe(origin.teamId, { kind: 'memory', outcome: 'forgotten' });
  await sink.notice('info', `Forgot a note in <#${channel}>. It no longer grounds answers.`);
}

/**
 * Notes that may ground a turn reading `channel`: live, unexpired, and added by someone who is
 * still a member (a note leaves with its author).
 */
export async function notesFor(
  orch: Orchestrator,
  teamId: string,
  channel: string | undefined,
): Promise<ChannelNote[]> {
  if (!channel || !orch.deps.features?.has('memory')) return [];
  const cutoff = new Date(Date.now() - MEMORY_LIMITS.ttlDays * 86_400_000).toISOString();
  const live = (await orch.deps.stores.notes(teamId, channel)).filter(
    (n) => !n.forgottenAt && n.at >= cutoff,
  );
  const stillMember = new Map<string, boolean>();
  for (const a of new Set(live.map((n) => n.author))) {
    stillMember.set(a, await orch.deps.surface.isMember(channel, a).catch(() => false));
  }
  return live.filter((n) => stillMember.get(n.author));
}
