import { describe, expect, it, vi } from 'vitest';
import type { FaqRequest } from '@ge-slack/contracts';
import { MemoryStore } from '@ge-slack/identity';
import { FaqService, decideFaq, removeFaq } from './faq.js';
import type { Orchestrator } from './orchestrator.js';
import { RuntimeStores } from './stores.js';
import { FakeSurface, RecordingSink } from './testing.js';
import type { ConversationInfo } from './ports.js';

const DRAFTER = 'U0DRAFTER';
const STEWARD = 'U0STEWARD';
const SOURCE = 'C0SOURCE';
const SECOND = 'C0SECOND';
const STEWARDS = 'C0STEWARDS';
const NOW = '2026-10-25T00:00:00.000Z';

/** Deliberately stale cached metadata/access: final publication must ask for fresh values. */
class CachedSurface extends FakeSurface {
  freshInfo = new Map<string, ConversationInfo>();
  freshMembers = new Map<string, Set<string>>();
  infoReads: Array<{ channel: string; fresh: boolean }> = [];
  memberReads: Array<{ channel: string; user: string; fresh: boolean }> = [];

  override async conversationInfo(channel: string, opts?: { fresh?: boolean }) {
    this.infoReads.push({ channel, fresh: opts?.fresh === true });
    return (
      (opts?.fresh ? this.freshInfo.get(channel) : undefined) ?? super.conversationInfo(channel)
    );
  }
  override async isMember(channel: string, user: string, opts?: { fresh?: boolean }) {
    this.memberReads.push({ channel, user, fresh: opts?.fresh === true });
    return (
      (opts?.fresh ? this.freshMembers.get(channel)?.has(user) : undefined) ??
      super.isMember(channel, user)
    );
  }
}

async function setup(status: FaqRequest['status'] = 'open') {
  const kv = new MemoryStore();
  const surface = new CachedSurface();
  for (const channel of [SOURCE, SECOND]) {
    surface.info.set(channel, { id: channel, isPrivate: false, isIm: false, isExtShared: false });
    surface.members.set(channel, new Set([DRAFTER]));
  }
  surface.info.set(STEWARDS, { id: STEWARDS, isPrivate: true, isIm: false, isExtShared: false });
  surface.members.set(STEWARDS, new Set([STEWARD]));
  const writer = {
    create: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
  };
  const faq = new FaqService(kv, {
    writer,
    tokens: { getAccessToken: async () => 'test-curator' },
    dataStoreTitle: 'Test FAQ',
    stewardsChannel: STEWARDS,
    stewards: [STEWARD],
    channels: [SOURCE, SECOND],
  });
  const request: FaqRequest = {
    id: 'faq-source-recheck',
    teamId: 'T0TEST',
    drafterId: DRAFTER,
    question: 'What was decided?',
    answer: 'This is an explicitly approved sample answer.',
    sources: [],
    channel: SOURCE,
    readChannels: [SOURCE, SECOND],
    status,
    at: NOW,
    card: { channel: STEWARDS, ts: '1700000000.000001' },
    ...(status === 'published' ? { documentId: 'faq-source-recheck' } : {}),
  };
  await faq.save(request);
  await faq.lock(
    request.teamId,
    status === 'published' ? `${request.id}-remove` : request.id,
    status === 'published',
  );
  const orch = {
    deps: { features: new Set(['faq']), faq, surface, stores: new RuntimeStores(kv) },
    now: () => new Date(NOW),
    observe: vi.fn(),
  } as unknown as Orchestrator;
  return { faq, surface, writer, request, orch };
}

async function publish(env: Awaited<ReturnType<typeof setup>>) {
  const sink = new RecordingSink();
  await decideFaq(
    env.orch,
    env.request.teamId,
    env.request.id,
    STEWARD,
    'publish',
    sink,
    env.request.card,
  );
  return sink;
}

describe('FAQ publication rechecks the disclosure boundary', () => {
  it.each([{ isPrivate: true }, { isExtShared: true }, { isIm: true }, { isMpim: true }])(
    'refuses a source whose current visibility changed: %j',
    async (changed) => {
      const env = await setup();
      env.surface.freshInfo.set(SECOND, {
        id: SECOND,
        isPrivate: false,
        isExtShared: false,
        isIm: false,
        ...changed,
      });
      const sink = await publish(env);
      expect(env.writer.create).not.toHaveBeenCalled();
      expect(sink.last<{ kind: string }>('notice')?.kind).toBe('denied');
      expect(env.surface.infoReads).toContainEqual({ channel: SECOND, fresh: true });
      expect((await env.faq.get(env.request.teamId, env.request.id))?.status).toBe('open');
    },
  );

  it('refuses when the original drafter lost access to any read conversation', async () => {
    const env = await setup();
    env.surface.freshMembers.set(SECOND, new Set());
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
    expect(env.surface.memberReads).toContainEqual({ channel: SECOND, user: DRAFTER, fresh: true });
  });

  it('refuses a source removed from the configured FAQ allow-list', async () => {
    const env = await setup();
    (env.faq.channels as Set<string>).delete(SECOND);
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
  });

  it('still publishes an eligible answer after fresh checks for every source', async () => {
    const env = await setup();
    await publish(env);
    expect(env.writer.create).toHaveBeenCalledOnce();
    expect(env.surface.infoReads).toEqual(
      expect.arrayContaining([
        { channel: SOURCE, fresh: true },
        { channel: SECOND, fresh: true },
        { channel: STEWARDS, fresh: true },
      ]),
    );
    expect((await env.faq.get(env.request.teamId, env.request.id))?.status).toBe('published');
  });

  it('does not export content through a stewards channel that became external', async () => {
    const env = await setup();
    env.surface.freshInfo.set(STEWARDS, {
      id: STEWARDS,
      isPrivate: true,
      isExtShared: true,
      isIm: false,
    });
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
  });

  it('lets a current steward remove a published document after a channel changes visibility', async () => {
    const env = await setup('published');
    env.surface.freshInfo.set(STEWARDS, {
      id: STEWARDS,
      isPrivate: true,
      isExtShared: true,
      isIm: false,
    });
    env.surface.freshMembers.set(SOURCE, new Set());
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).toHaveBeenCalledOnce();
    expect(env.surface.faqCards).toHaveLength(0);
    expect((await env.faq.get(env.request.teamId, env.request.id))?.status).toBe('removed');
  });

  it('refuses removal by a steward whose current channel membership was revoked', async () => {
    const env = await setup('published');
    env.surface.freshMembers.set(STEWARDS, new Set());
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).not.toHaveBeenCalled();
  });

  it('preserves a known publication when saving its status fails, without reopening approval', async () => {
    const env = await setup();
    vi.spyOn(env.faq, 'save').mockRejectedValueOnce(new Error('request checkpoint failed'));
    const sink = await publish(env);
    expect(env.writer.create).toHaveBeenCalledOnce();
    expect(sink.last<{ text: string }>('notice')?.text).toContain('FAQ was published');
    expect((await env.orch.deps.stores.getEntry(env.request.teamId, env.request.id))?.outcome).toBe(
      'applied',
    );
    await publish(env);
    expect(env.writer.create).toHaveBeenCalledOnce();
    // The independently stored known receipt still permits the steward's inverse.
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).toHaveBeenCalledOnce();
  });

  it('does not replay a publication even if a stale approval lock is restored', async () => {
    const env = await setup();
    env.writer.create.mockRejectedValueOnce(new Error('outcome uncertain'));
    await publish(env);
    expect((await env.orch.deps.stores.getEntry(env.request.teamId, env.request.id))?.outcome).toBe(
      'uncertain',
    );
    await env.faq.lock(env.request.teamId, env.request.id);
    await publish(env);
    expect(env.writer.create).toHaveBeenCalledOnce();
  });

  it('refuses before publication when durable claiming is unavailable', async () => {
    const env = await setup();
    vi.spyOn(env.orch.deps.stores, 'claimEffect').mockRejectedValueOnce(new Error('unavailable'));
    const sink = await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
    expect(sink.last<{ text: string }>('notice')?.text).toContain('nothing was dispatched');
  });

  it('refuses before publication if the preflight ledger checkpoint fails', async () => {
    const env = await setup();
    vi.spyOn(env.orch.deps.stores, 'record').mockRejectedValueOnce(new Error('unavailable'));
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
  });

  it('preserves a known removal after status checkpoint failure and does not replay it', async () => {
    const env = await setup('published');
    vi.spyOn(env.faq, 'save').mockRejectedValueOnce(new Error('request checkpoint failed'));
    const sink = new RecordingSink();
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, sink);
    expect(env.writer.remove).toHaveBeenCalledOnce();
    expect(sink.last<{ text: string }>('notice')?.text).toContain('FAQ was removed');
    expect(
      (await env.orch.deps.stores.getEntry(env.request.teamId, env.request.id))?.undoneAt,
    ).toBe(NOW);
    await env.faq.lock(env.request.teamId, `${env.request.id}-remove`, true);
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).toHaveBeenCalledOnce();
  });

  it('uses the atomic inverse claim even if a legacy removal lock was not checkpointed', async () => {
    const env = await setup('published');
    await env.faq.take(env.request.teamId, `${env.request.id}-remove`);
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).toHaveBeenCalledOnce();
  });

  it('rechecks source visibility after durable preflight I/O, immediately before publication', async () => {
    const env = await setup();
    const record = env.orch.deps.stores.record.bind(env.orch.deps.stores);
    vi.spyOn(env.orch.deps.stores, 'record').mockImplementationOnce(async (entry) => {
      await record(entry);
      env.surface.freshInfo.set(SECOND, {
        id: SECOND,
        isPrivate: true,
        isExtShared: false,
        isIm: false,
      });
    });
    await publish(env);
    expect(env.writer.create).not.toHaveBeenCalled();
    expect((await env.orch.deps.stores.getEntry(env.request.teamId, env.request.id))?.outcome).toBe(
      'rejected',
    );
  });

  it('suppresses a content-bearing card refresh if the stewards channel becomes external during publication', async () => {
    const env = await setup();
    env.writer.create.mockImplementationOnce(async () => {
      env.surface.freshInfo.set(STEWARDS, {
        id: STEWARDS,
        isPrivate: true,
        isExtShared: true,
        isIm: false,
      });
      return { ok: true as const };
    });
    await publish(env);
    expect(env.writer.create).toHaveBeenCalledOnce();
    expect(env.surface.faqCards).toHaveLength(0);
  });

  it('suppresses a content-bearing card refresh if the stewards channel becomes external during removal', async () => {
    const env = await setup('published');
    env.writer.remove.mockImplementationOnce(async () => {
      env.surface.freshInfo.set(STEWARDS, {
        id: STEWARDS,
        isPrivate: true,
        isExtShared: true,
        isIm: false,
      });
      return { ok: true as const };
    });
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, new RecordingSink());
    expect(env.writer.remove).toHaveBeenCalledOnce();
    expect(env.surface.faqCards).toHaveLength(0);
  });

  it('suppresses a rejected FAQ card refresh after a status checkpoint changes channel visibility', async () => {
    const env = await setup();
    const save = env.faq.save.bind(env.faq);
    vi.spyOn(env.faq, 'save').mockImplementationOnce(async (r) => {
      await save(r);
      env.surface.freshInfo.set(STEWARDS, {
        id: STEWARDS,
        isPrivate: true,
        isExtShared: true,
        isIm: false,
      });
    });
    await decideFaq(
      env.orch,
      env.request.teamId,
      env.request.id,
      STEWARD,
      'reject',
      new RecordingSink(),
      env.request.card,
    );
    expect(env.writer.create).not.toHaveBeenCalled();
    expect(env.surface.faqCards).toHaveLength(0);
  });

  it('rechecks a deleting steward after the durable inverse claim', async () => {
    const env = await setup('published');
    const claim = env.orch.deps.stores.claimEffect.bind(env.orch.deps.stores);
    vi.spyOn(env.orch.deps.stores, 'claimEffect').mockImplementationOnce(async (intent) => {
      const claimed = await claim(intent);
      env.surface.freshMembers.set(STEWARDS, new Set());
      return claimed;
    });
    const sink = new RecordingSink();
    await removeFaq(env.orch, env.request.teamId, env.request.id, STEWARD, sink);
    expect(env.writer.remove).not.toHaveBeenCalled();
    expect(sink.last<{ kind: string }>('notice')?.kind).toBe('denied');
  });
});
