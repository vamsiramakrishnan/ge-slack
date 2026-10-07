import {
  toSlackMetadata,
  type ActuationRequest,
  type ActuationResult,
  type Inverse,
} from '@ge-slack/contracts';
import type {
  CapturedContext,
  CapturedMessage,
  ConversationInfo,
  FaqCardView,
  LicenceRequestView,
  SuggestionView,
  ResolvedScope,
  SurfacePort,
} from '@ge-slack/runtime';
import { SlackApiError, must, slackErrorCode, type SlackApi } from './slack-api.js';
import {
  provenanceFooter,
  markdownBlocks,
  licenceRequestBlocks,
  suggestionBlocks,
  faqCardBlocks,
} from './blocks.js';

interface SearchHit {
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  author_user_id?: string;
  author_name?: string;
  is_author_bot?: boolean;
  permalink?: string;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  files?: Array<{ name?: string; title?: string }>;
}

export interface SlackSurfaceOptions {
  /** Our app id, to mark our own messages for the model. */
  appId?: string;
  /** Workspace domain for constructing permalinks (`acme` → acme.slack.com). */
  domain?: string;
  teamId: string;
  now?: () => number;
  /** Max pages of conversations.members to scan before failing closed. */
  maxMemberPages?: number;
  /** For the external file upload step (files.getUploadURLExternal → POST bytes). */
  fetchImpl?: typeof fetch;
  /**
   * Client used for writes and undo. Must not auto-retry (a retried chat.postMessage can land
   * twice); the app passes a WebClient with retries disabled (M6). Defaults to the read client.
   */
  writeApi?: SlackApi;
}

const MEMBER_TTL_MS = 2 * 60_000;
const INFO_TTL_MS = 5 * 60_000;

/**
 * SurfacePort over the Slack Web API — the only place the bot reads or mutates Slack.
 * Reads are bounded; writes carry `ge_provenance` metadata and return a host inverse.
 */
export class SlackSurface implements SurfacePort {
  private readonly memberCache = new Map<string, { ok: boolean; at: number }>();
  private readonly infoCache = new Map<string, { v: ConversationInfo; at: number }>();
  private readonly nameCache = new Map<string, string>();
  private domain: string | undefined;
  private readonly now: () => number;
  private readonly writeApi: SlackApi;

  constructor(
    private readonly api: SlackApi,
    private readonly opts: SlackSurfaceOptions,
  ) {
    this.domain = opts.domain;
    this.now = opts.now ?? Date.now;
    this.writeApi = opts.writeApi ?? api;
  }

  async canvasAccess(id: string): Promise<{ isCanvas: boolean; channels: string[] }> {
    try {
      const r = await must(this.api, 'files.info', { file: id });
      const f = r.file as {
        filetype?: string;
        pretty_type?: string;
        channels?: string[];
        groups?: string[];
        ims?: string[];
      };
      const isCanvas =
        f.filetype === 'quip' || f.filetype === 'canvas' || f.pretty_type === 'Canvas';
      return { isCanvas, channels: [...(f.channels ?? []), ...(f.groups ?? []), ...(f.ims ?? [])] };
    } catch {
      return { isCanvas: false, channels: [] };
    }
  }

  async conversationInfo(channel: string): Promise<ConversationInfo> {
    const hit = this.infoCache.get(channel);
    if (hit && this.now() - hit.at < INFO_TTL_MS) return hit.v;
    const r = await must(this.api, 'conversations.info', { channel });
    const c = r.channel as Record<string, unknown>;
    const v: ConversationInfo = {
      id: channel,
      ...(typeof c.name === 'string' ? { name: c.name } : {}),
      isPrivate: c.is_private === true,
      isIm: c.is_im === true || c.is_mpim === true,
      // Fail toward the stricter policy: any shared signal counts as externally shared.
      isExtShared:
        c.is_ext_shared === true || c.is_pending_ext_shared === true || c.is_shared === true,
    };
    this.infoCache.set(channel, { v, at: this.now() });
    return v;
  }

  async isMember(
    channel: string,
    userId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<boolean> {
    const key = `${channel}:${userId}`;
    const hit = this.memberCache.get(key);
    if (!opts.fresh && hit && this.now() - hit.at < MEMBER_TTL_MS) return hit.ok;
    let ok = false;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < (this.opts.maxMemberPages ?? 20); page++) {
        const r = await must(this.api, 'conversations.members', {
          channel,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        if ((r.members as string[] | undefined)?.includes(userId)) {
          ok = true;
          break;
        }
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    } catch {
      ok = false; // not_in_channel, channel_not_found, … → fail closed
    }
    this.memberCache.set(key, { ok, at: this.now() });
    return ok;
  }

  /** Guests (single/multi-channel) can't search the workspace. Fails closed. */
  /** A short DM from the app (a job finished), with an optional link to the thread. */
  async notifyUser(
    userId: string,
    msg: { text: string; link?: { channel: string; ts: string } },
  ): Promise<void> {
    const im = await must(this.writeApi, 'conversations.open', { users: userId });
    const channel = (im.channel as { id?: string } | undefined)?.id;
    if (!channel) return;
    const href = msg.link ? this.permalink(msg.link.channel, msg.link.ts) : undefined;
    await must(this.writeApi, 'chat.postMessage', {
      channel,
      text: href ? `${msg.text} <${href}|Open the thread>` : msg.text,
      unfurl_links: false,
    });
  }

  /** A suggested answer, ephemeral to the asker in their thread (ADR-0003 §3). */
  async suggestPrivately(
    channel: string,
    userId: string,
    threadTs: string,
    view: SuggestionView,
  ): Promise<void> {
    await must(this.writeApi, 'chat.postEphemeral', {
      channel,
      user: userId,
      thread_ts: threadTs,
      text: 'Gemini suggests an answer (only you can see this)',
      blocks: suggestionBlocks(view),
    });
  }

  /** Post or update a FAQ card in the stewards' channel (ADR-0003 §5). */
  async faqCard(
    channel: string,
    view: FaqCardView,
    ts?: string,
  ): Promise<{ channel: string; ts: string }> {
    const body = {
      channel,
      text: `FAQ draft from <@${view.drafterId}>`,
      blocks: faqCardBlocks(view),
      unfurl_links: false,
    };
    const r = ts
      ? await must(this.writeApi, 'chat.update', { ...body, ts })
      : await must(this.writeApi, 'chat.postMessage', body);
    return { channel: String(r.channel ?? channel), ts: String(r.ts ?? ts ?? '') };
  }

  /** Post or update a licence request card in the admins' channel (EXPERIENCE §11). */
  async licenceRequestCard(
    channel: string,
    view: LicenceRequestView,
    ts?: string,
  ): Promise<{ channel: string; ts: string }> {
    const body = {
      channel,
      text: `Gemini Enterprise licence request from <@${view.requesterId}>`,
      blocks: licenceRequestBlocks(view),
      unfurl_links: false,
    };
    const r = ts
      ? await must(this.writeApi, 'chat.update', { ...body, ts })
      : await must(this.writeApi, 'chat.postMessage', body);
    return { channel: String(r.channel ?? channel), ts: String(r.ts ?? ts ?? '') };
  }

  /** Workspace admins/owners (admin insights, ledger export). Fails closed. */
  async isWorkspaceAdmin(userId: string): Promise<boolean> {
    try {
      const r = await must(this.api, 'users.info', { user: userId });
      const u = r.user as { is_admin?: boolean; is_owner?: boolean; team_id?: string };
      // Enterprise Grid: an admin of another workspace in the org is not an admin here.
      return Boolean((u.is_admin || u.is_owner) && u.team_id === this.opts.teamId);
    } catch {
      return false;
    }
  }

  /**
   * DM a file to one person (ledger export): files.getUploadURLExternal → POST the bytes →
   * files.completeUploadExternal into their DM. Never shared to a channel.
   */
  async sendFile(
    userId: string,
    file: { name: string; title: string; content: string; comment?: string },
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const im = await must(this.writeApi, 'conversations.open', { users: userId });
      const channel = (im.channel as { id?: string } | undefined)?.id;
      if (!channel) return { ok: false, message: 'Could not open a DM.' };
      const bytes = new TextEncoder().encode(file.content);
      const up = await must(this.writeApi, 'files.getUploadURLExternal', {
        filename: file.name,
        length: bytes.byteLength,
      });
      const url = String(up.upload_url ?? '');
      if (!/^https:\/\/files\.slack\.com\//.test(url)) {
        return { ok: false, message: 'Slack returned an unexpected upload URL.' };
      }
      const f = this.opts.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
      const res = await f(url, { method: 'POST', body: bytes });
      if (!res.ok) return { ok: false, message: `Upload failed (${res.status}).` };
      await must(this.writeApi, 'files.completeUploadExternal', {
        files: [{ id: up.file_id, title: file.title }],
        channel_id: channel,
        ...(file.comment ? { initial_comment: file.comment } : {}),
      });
      return { ok: true, message: 'Sent to your DM.' };
    } catch (err) {
      return { ok: false, message: `Upload failed: ${slackErrorCode(err) ?? 'error'}` };
    }
  }

  async isGuest(userId: string): Promise<boolean> {
    try {
      const r = await must(this.api, 'users.info', { user: userId });
      const u = r.user as {
        is_restricted?: boolean;
        is_ultra_restricted?: boolean;
        is_stranger?: boolean;
        team_id?: string;
      };
      // Guests, and members of another org reaching us through Slack Connect (M4).
      return Boolean(
        u.is_restricted ||
        u.is_ultra_restricted ||
        u.is_stranger ||
        (u.team_id && u.team_id !== this.opts.teamId),
      );
    } catch {
      return true;
    }
  }

  async userEmail(userId: string): Promise<string | undefined> {
    const r = await must(this.api, 'users.info', { user: userId });
    const user = r.user as { profile?: { email?: string }; deleted?: boolean; is_bot?: boolean };
    if (user.deleted || user.is_bot) return undefined;
    return user.profile?.email;
  }

  private async ensureDomain(): Promise<string | undefined> {
    if (this.domain) return this.domain;
    try {
      const r = await must(this.api, 'team.info', {});
      this.domain = (r.team as { domain?: string }).domain;
    } catch {
      /* permalinks become ts handles */
    }
    return this.domain;
  }

  permalink(channel: string, ts: string, threadTs?: string): string | undefined {
    if (!this.domain) return undefined;
    const base = `https://${this.domain}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
    return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
  }

  private async authorName(user: string | undefined): Promise<string | undefined> {
    if (!user) return undefined;
    const hit = this.nameCache.get(user);
    if (hit) return hit;
    if (this.nameCache.size > 2000) this.nameCache.clear();
    try {
      const r = await must(this.api, 'users.info', { user });
      const u = r.user as {
        real_name?: string;
        name?: string;
        profile?: { display_name?: string };
      };
      const name = u.profile?.display_name || u.real_name || u.name;
      if (name) this.nameCache.set(user, name);
      return name;
    } catch {
      return undefined;
    }
  }

  private async toCaptured(
    channel: string,
    msgs: SlackMessage[],
    threadTs?: string,
  ): Promise<CapturedMessage[]> {
    await this.ensureDomain();
    const names = new Map<string, string | undefined>();
    for (const u of new Set(
      msgs.map((m) => m.user).filter((u): u is string => Boolean(u)),
    ).values()) {
      if (names.size >= 50) break;
      names.set(u, await this.authorName(u));
    }
    return msgs
      .filter(
        (m) =>
          !m.subtype ||
          m.subtype === 'thread_broadcast' ||
          m.subtype === 'bot_message' ||
          m.subtype === 'file_share',
      )
      .map((m) => {
        const files = (m.files ?? [])
          .map((f) => `[file: ${f.title ?? f.name ?? 'attachment'}]`)
          .join(' ');
        const author = m.user ? names.get(m.user) : undefined;
        const permalink = this.permalink(channel, m.ts, threadTs ?? m.thread_ts);
        return {
          ts: m.ts,
          ...(m.user ? { user: m.user } : {}),
          ...(author ? { author } : {}),
          text: [m.text ?? '', files].filter(Boolean).join(' '),
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
          ...(m.reply_count ? { replyCount: m.reply_count } : {}),
          ...(permalink ? { permalink } : {}),
          ...(this.opts.appId && m.app_id === this.opts.appId ? { fromApp: true } : {}),
        };
      });
  }

  async capture(
    scope: ResolvedScope,
    opts: { from: string[]; maxMessages: number; search?: string; actionToken?: string },
  ): Promise<CapturedContext> {
    const filter = (ms: CapturedMessage[]) =>
      ms.filter(
        (m) =>
          (!opts.from.length || (m.user && opts.from.includes(m.user))) &&
          (!opts.search || m.text.toLowerCase().includes(opts.search.toLowerCase())),
      );

    switch (scope.kind) {
      case 'none':
        return { label: 'no conversation', messages: [], truncated: false };
      case 'search': {
        if (opts.actionToken) {
          const found = await this.search(scope.query, opts.actionToken, opts.from).catch(
            () => undefined,
          );
          if (found) return found;
        }
        // No action token (slash commands) or search unavailable: keyword filter of this channel.
        const inner = await this.capture(
          { kind: 'channel', channel: scope.channel, sinceMs: scope.sinceMs },
          { ...opts, search: scope.query },
        );
        return {
          ...inner,
          label: `${inner.label} · keyword “${scope.query.slice(0, 60)}” (workspace search works from @Gemini or the Gemini DM)`,
        };
      }
      case 'thread':
      case 'message': {
        const { messages, truncated } = await this.page(
          'conversations.replies',
          { channel: scope.channel, ts: scope.ts },
          opts.maxMessages,
        );
        const msgs =
          scope.kind === 'message' ? messages.filter((m) => m.ts === scope.ts) : messages;
        if (scope.kind === 'message' && msgs.length === 0) {
          // Not a thread parent: fetch the single message from history.
          const r = await must(this.api, 'conversations.history', {
            channel: scope.channel,
            latest: scope.ts,
            inclusive: true,
            limit: 1,
          });
          msgs.push(...((r.messages as SlackMessage[]) ?? []));
        }
        const info = await this.conversationInfo(scope.channel);
        return {
          label: `${scope.kind === 'thread' ? 'thread' : 'message'} in #${info.name ?? scope.channel}`,
          channel: scope.channel,
          threadTs: scope.ts,
          messages: filter(
            await this.toCaptured(
              scope.channel,
              msgs,
              scope.kind === 'thread' ? scope.ts : undefined,
            ),
          ),
          truncated,
        };
      }
      case 'channel':
      case 'dm': {
        const oldest =
          scope.kind === 'channel' ? String((this.now() - scope.sinceMs) / 1000) : undefined;
        const { messages, truncated } = await this.page(
          'conversations.history',
          { channel: scope.channel, ...(oldest ? { oldest } : {}) },
          opts.maxMessages,
        );
        const info = await this.conversationInfo(scope.channel);
        const days =
          scope.kind === 'channel' ? Math.max(1, Math.round(scope.sinceMs / 86_400_000)) : 0;
        return {
          label:
            scope.kind === 'channel' ? `#${info.name ?? scope.channel} · last ${days}d` : 'this DM',
          channel: scope.channel,
          messages: filter(await this.toCaptured(scope.channel, messages.reverse())),
          truncated,
        };
      }
      case 'canvas': {
        // Full markdown via canvases.getContent; fall back to file metadata/preview if unavailable.
        const content = await must(this.api, 'canvases.getContent', {
          canvas_id: scope.id,
          content_type: 'markdown',
        }).catch(() => undefined);
        const r = await must(this.api, 'files.info', { file: scope.id });
        const f = r.file as {
          title?: string;
          name?: string;
          preview?: string;
          plain_text?: string;
        };
        return {
          label: `canvas ${f.title ?? scope.id}`,
          ...(scope.channel ? { channel: scope.channel } : {}),
          messages: [],
          canvas: {
            id: scope.id,
            title: f.title ?? f.name ?? 'Canvas',
            markdown:
              typeof content?.content === 'string'
                ? content.content
                : (f.plain_text ?? f.preview ?? ''),
          },
          truncated: typeof content?.content !== 'string' && !(f.plain_text ?? f.preview),
        };
      }
    }
  }

  /**
   * Action items → a Slack List (owner, due, done), shared to the conversation and announced in
   * the thread. Lists are paid-plan only: on a definite Slack refusal we post the same items as a
   * checklist and say so on the receipt. Undo deletes the items and the announcement (Slack has
   * no list delete, so an empty list remains — stated plainly).
   */
  private async actionItems(
    req: ActuationRequest,
    base: { changeId: string; kind: 'action-items' },
    messageBody: (text: string) => Record<string, unknown>,
  ): Promise<ActuationResult> {
    const p = req.params as Extract<ActuationRequest['params'], { kind: 'action-items' }>;
    const thread = p.threadTs ? { thread_ts: p.threadTs } : {};
    const line = (i: (typeof p.items)[number]) =>
      `${i.owner ? `<@${i.owner}> ` : ''}${i.text}${i.due ? ` — due ${i.due}` : ''}`;

    const postChecklist = async (note: string): Promise<ActuationResult> => {
      const text = [`*${p.title}*`, ...p.items.map((i) => `☐ ${line(i)}`)].join('\n');
      const r = await must(this.writeApi, 'chat.postMessage', {
        channel: p.channel,
        ...thread,
        ...messageBody(text),
      });
      const ts = r.ts as string;
      await this.ensureDomain();
      const permalink = this.permalink(p.channel, ts, p.threadTs);
      return {
        ...base,
        outcome: 'applied',
        location: { channel: p.channel, ts, ...(permalink ? { permalink } : {}) },
        inverse: { op: 'delete-message', channel: p.channel, ts },
        provenancePersisted: req.provenance !== undefined,
        note,
      };
    };

    let listId: string;
    const columns = new Map<string, string>();
    try {
      const created = await must(this.writeApi, 'slackLists.create', {
        name: p.title,
        schema: [
          { key: 'task', name: 'Task', type: 'text', is_primary_column: true },
          { key: 'owner', name: 'Owner', type: 'user', options: { format: 'single_entity' } },
          { key: 'due', name: 'Due', type: 'date' },
          { key: 'done', name: 'Done', type: 'checkbox' },
        ],
      });
      listId = created.list_id as string;
      const schema =
        (created.list_metadata as { schema?: Array<{ key: string; id: string }> } | undefined)
          ?.schema ?? [];
      for (const c of schema) columns.set(c.key, c.id);
      if (!listId || !columns.get('task'))
        throw new SlackApiError('slackLists.create', 'missing_list_metadata');
    } catch (err) {
      if (slackErrorCode(err))
        return postChecklist('Slack Lists isn’t available here — posted as a checklist instead.');
      throw err;
    }

    const itemIds: string[] = [];
    try {
      for (const item of p.items) {
        const fields: Array<Record<string, unknown>> = [
          {
            column_id: columns.get('task'),
            rich_text: [
              {
                type: 'rich_text',
                elements: [
                  { type: 'rich_text_section', elements: [{ type: 'text', text: item.text }] },
                ],
              },
            ],
          },
        ];
        if (item.owner && columns.get('owner'))
          fields.push({ column_id: columns.get('owner'), user: [item.owner] });
        if (item.due && columns.get('due'))
          fields.push({ column_id: columns.get('due'), date: [item.due] });
        const r = await must(this.writeApi, 'slackLists.items.create', {
          list_id: listId,
          initial_fields: fields,
        });
        itemIds.push((r.item as { id: string }).id);
      }
    } catch (err) {
      if (itemIds.length) {
        await must(this.writeApi, 'slackLists.items.deleteMultiple', {
          list_id: listId,
          ids: itemIds,
        }).catch(() => undefined);
      }
      if (slackErrorCode(err))
        return postChecklist('Couldn’t fill the Slack List — posted as a checklist instead.');
      throw err;
    }

    // Write access so the conversation can tick items done; the announcement carries provenance.
    const shared = await must(this.writeApi, 'slackLists.access.set', {
      list_id: listId,
      access_level: 'write',
      channel_ids: [p.channel],
    })
      .then(() => true)
      .catch(() => false);
    const file = await must(this.api, 'files.info', { file: listId }).catch(() => undefined);
    const listLink = (file?.file as { permalink?: string } | undefined)?.permalink;
    const announce = `✅ *${p.title}* — ${p.items.length} action item${p.items.length === 1 ? '' : 's'}${listLink ? ` · <${listLink}|Open the list>` : ''}\n${p.items.map((i) => `• ${line(i)}`).join('\n')}`;
    const shareNote = shared
      ? undefined
      : 'The list was created but could not be shared to the conversation.';
    let ts: string | undefined;
    try {
      const r = await must(this.writeApi, 'chat.postMessage', {
        channel: p.channel,
        ...thread,
        ...messageBody(announce),
      });
      ts = r.ts as string;
    } catch (err) {
      // The list exists now: never report "nothing landed" — keep the undo for its items (M6).
      if (!slackErrorCode(err)) throw err;
    }
    const note = [shareNote, ts ? undefined : 'The announcement could not be posted.']
      .filter(Boolean)
      .join(' ');
    return {
      ...base,
      outcome: 'applied',
      location: {
        channel: p.channel,
        ...(ts ? { ts } : {}),
        listId,
        ...(listLink ? { permalink: listLink } : {}),
      },
      inverse: {
        op: 'delete-list-items',
        listId,
        itemIds,
        ...(ts ? { announcement: { channel: p.channel, ts } } : {}),
      },
      // Provenance lives in the announcement's metadata; without it there is none.
      provenancePersisted: Boolean(ts) && req.provenance !== undefined,
      ...(note ? { note } : {}),
    };
  }

  /** Real-time Search over public channels (bot token + the event's action_token). Never stored. */
  private async search(
    query: string,
    actionToken: string,
    from: string[],
  ): Promise<CapturedContext> {
    const r = await must(this.api, 'assistant.search.context', {
      query: query.slice(0, 500),
      action_token: actionToken,
      channel_types: ['public_channel'],
      content_types: ['messages'],
      include_bots: false,
      limit: 20,
      sort: 'score',
    });
    const raw = (r.results as { messages?: SearchHit[] } | undefined)?.messages ?? [];
    // Trust but verify: keep only hits from public, non-DM conversations (L2).
    const publicChannel = new Map<string, boolean>();
    for (const c of new Set(raw.map((m) => m.channel_id).filter((c): c is string => Boolean(c)))) {
      const info = await this.conversationInfo(c).catch(() => undefined);
      publicChannel.set(c, Boolean(info && !info.isPrivate && !info.isIm));
    }
    const results = raw.filter((m) => m.channel_id && publicChannel.get(m.channel_id));
    const names = new Map<string, string>();
    const messages: CapturedMessage[] = results
      .filter(
        (m) =>
          m.channel_id &&
          m.message_ts &&
          (!from.length || (m.author_user_id && from.includes(m.author_user_id))),
      )
      .map((m) => {
        if (m.author_user_id && m.author_name) names.set(m.author_user_id, m.author_name);
        return {
          ts: m.message_ts!,
          channel: m.channel_id!,
          ...(m.author_user_id ? { user: m.author_user_id } : {}),
          ...(m.author_name
            ? { author: `${m.author_name}${m.channel_name ? ` in #${m.channel_name}` : ''}` }
            : {}),
          text: m.content ?? '',
          ...(m.permalink ? { permalink: m.permalink } : {}),
        };
      });
    return {
      label: `Slack search “${query.slice(0, 60)}” · ${messages.length} result${messages.length === 1 ? '' : 's'} (public channels)`,
      messages,
      truncated: Boolean(r.response_metadata?.next_cursor),
    };
  }

  private async page(
    method: string,
    args: Record<string, unknown>,
    max: number,
  ): Promise<{ messages: SlackMessage[]; truncated: boolean }> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await must(this.api, method, {
        ...args,
        limit: Math.min(200, max - out.length),
        ...(cursor ? { cursor } : {}),
      });
      out.push(...((r.messages as SlackMessage[]) ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor || out.length >= max)
        return { messages: out.slice(0, max), truncated: Boolean(cursor) };
    }
  }

  // ------------------------------------------------------------------ writes

  async actuate(req: ActuationRequest): Promise<ActuationResult> {
    const p = req.params;
    const base = { changeId: req.changeId, kind: p.kind } as const;
    const meta = req.provenance ? toSlackMetadata(req.provenance) : undefined;
    const footer = req.provenance
      ? provenanceFooter({
          invoker: req.provenance.invoker,
          principal: req.provenance.principal,
          sources: req.provenance.sources.length,
          approval: req.provenance.approval,
          ...(req.provenance.automationId ? { automationId: req.provenance.automationId } : {}),
          changeId: req.changeId,
        })
      : undefined;
    const messageBody = (text: string) => ({
      text,
      blocks: [...markdownBlocks(text), ...(footer ? [footer] : [])],
      ...(meta ? { metadata: meta } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });

    try {
      switch (p.kind) {
        case 'connector-action':
          // Connector actions run through Gemini Enterprise (runtime ConnectorPort), never Slack.
          return {
            ...base,
            outcome: 'rejected',
            provenancePersisted: false,
            error: {
              code: 'not_a_slack_write',
              message: 'Connector actions are not Slack writes.',
            },
          };
        case 'reply':
        case 'post': {
          const r = await must(this.writeApi, 'chat.postMessage', {
            channel: p.channel,
            ...(p.kind === 'reply' ? { thread_ts: p.threadTs } : {}),
            ...messageBody(p.text),
          });
          const ts = r.ts as string;
          const channel = (r.channel as string) ?? p.channel;
          await this.ensureDomain();
          const permalink = this.permalink(
            channel,
            ts,
            p.kind === 'reply' ? p.threadTs : undefined,
          );
          return {
            ...base,
            outcome: 'applied',
            location: { channel, ts, ...(permalink ? { permalink } : {}) },
            inverse: { op: 'delete-message', channel, ts },
            provenancePersisted: meta !== undefined,
          };
        }
        case 'canvas': {
          const r = await must(this.writeApi, 'canvases.create', {
            title: p.title,
            document_content: { type: 'markdown', markdown: p.markdown },
          });
          const canvasId = r.canvas_id as string;
          if (p.shareTo) {
            try {
              await must(this.writeApi, 'canvases.access.set', {
                canvas_id: canvasId,
                access_level: 'read',
                channel_ids: [p.shareTo],
              });
            } catch {
              // Created but not shared: report honestly rather than rolling back silently.
              return {
                ...base,
                outcome: 'applied',
                location: { canvasId },
                inverse: { op: 'delete-canvas', canvasId },
                provenancePersisted: false,
                error: {
                  code: 'share_failed',
                  message: 'Canvas created but could not be shared to the channel.',
                },
              };
            }
          }
          await this.ensureDomain();
          return {
            ...base,
            outcome: 'applied',
            location: {
              canvasId,
              ...(this.domain
                ? {
                    permalink: `https://${this.domain}.slack.com/docs/${this.opts.teamId}/${canvasId}`,
                  }
                : {}),
            },
            inverse: { op: 'delete-canvas', canvasId },
            provenancePersisted: false,
          };
        }
        case 'canvas-edit': {
          let sectionId = p.sectionId;
          if (p.heading) {
            // Resolve the heading to exactly one section; never guess between several.
            const found = await must(this.api, 'canvases.sections.lookup', {
              canvas_id: p.canvasId,
              criteria: { section_types: ['any_header'], contains_text: p.heading },
            });
            const sections = (found.sections as Array<{ id: string }> | undefined) ?? [];
            if (sections.length !== 1) {
              return {
                ...base,
                outcome: 'failed',
                provenancePersisted: false,
                error: {
                  code: sections.length ? 'heading_ambiguous' : 'heading_not_found',
                  message: sections.length
                    ? `${sections.length} sections match “${p.heading}”; nothing was changed.`
                    : `No section heading contains “${p.heading}”; nothing was changed.`,
                },
              };
            }
            sectionId = sections[0]!.id;
          }
          await must(this.writeApi, 'canvases.edit', {
            canvas_id: p.canvasId,
            changes: [
              {
                operation: 'replace',
                ...(sectionId ? { section_id: sectionId } : {}),
                document_content: { type: 'markdown', markdown: p.markdown },
              },
            ],
          });
          return {
            ...base,
            outcome: 'applied',
            location: { canvasId: p.canvasId },
            inverse: {
              op: 'not-reversible',
              reason: 'Slack does not expose the previous canvas content to restore',
            },
            provenancePersisted: false,
          };
        }
        case 'action-items':
          return await this.actionItems(
            req,
            { changeId: req.changeId, kind: 'action-items' },
            messageBody,
          );
        case 'schedule':
        case 'remind': {
          let channel: string;
          let text = p.text;
          if (p.kind === 'remind') {
            const open = await must(this.writeApi, 'conversations.open', { users: p.user });
            channel = (open.channel as { id: string }).id;
            text = `🔔 Reminder${req.provenance ? ` (requested by <@${req.provenance.invoker}>)` : ''}: ${p.text}`;
          } else channel = p.channel;
          const r = await must(this.writeApi, 'chat.scheduleMessage', {
            channel,
            post_at: p.postAt,
            ...messageBody(text),
          });
          const id = r.scheduled_message_id as string;
          return {
            ...base,
            outcome: 'applied',
            location: { channel },
            inverse: { op: 'delete-scheduled', channel, scheduledMessageId: id, postAt: p.postAt },
            provenancePersisted: meta !== undefined,
          };
        }
        case 'bookmark': {
          const r = await must(this.writeApi, 'bookmarks.add', {
            channel_id: p.channel,
            title: p.title,
            type: 'link',
            link: p.link,
          });
          const id = (r.bookmark as { id: string }).id;
          return {
            ...base,
            outcome: 'applied',
            location: { channel: p.channel },
            inverse: { op: 'remove-bookmark', channel: p.channel, bookmarkId: id },
            provenancePersisted: false,
          };
        }
        case 'react':
          await must(this.writeApi, 'reactions.add', {
            channel: p.channel,
            timestamp: p.ts,
            name: p.emoji,
          });
          return {
            ...base,
            outcome: 'applied',
            location: { channel: p.channel, ts: p.ts },
            inverse: { op: 'remove-reaction', channel: p.channel, ts: p.ts, emoji: p.emoji },
            provenancePersisted: false,
          };
      }
    } catch (err) {
      const code = slackErrorCode(err);
      if (code) {
        // Slack answered with a definite error: nothing landed.
        return {
          ...base,
          outcome: 'failed',
          provenancePersisted: false,
          error: { code, message: slackErrorText(code) },
        };
      }
      throw err; // transport failure: outcome unknown — the orchestrator records it as uncertain.
    }
  }

  async undo(inverse: Inverse): Promise<{ ok: boolean; message: string }> {
    try {
      switch (inverse.op) {
        case 'delete-message':
          await must(this.writeApi, 'chat.delete', { channel: inverse.channel, ts: inverse.ts });
          return { ok: true, message: 'Deleted the message.' };
        case 'delete-canvas':
          await must(this.writeApi, 'canvases.delete', { canvas_id: inverse.canvasId });
          return { ok: true, message: 'Deleted the canvas.' };
        case 'delete-scheduled':
          await must(this.writeApi, 'chat.deleteScheduledMessage', {
            channel: inverse.channel,
            scheduled_message_id: inverse.scheduledMessageId,
          });
          return { ok: true, message: 'Cancelled the scheduled message.' };
        case 'remove-bookmark':
          await must(this.writeApi, 'bookmarks.remove', {
            channel_id: inverse.channel,
            bookmark_id: inverse.bookmarkId,
          });
          return { ok: true, message: 'Removed the bookmark.' };
        case 'remove-reaction':
          await must(this.writeApi, 'reactions.remove', {
            channel: inverse.channel,
            timestamp: inverse.ts,
            name: inverse.emoji,
          });
          return { ok: true, message: 'Removed the reaction.' };
        case 'delete-list-items':
          await must(this.writeApi, 'slackLists.items.deleteMultiple', {
            list_id: inverse.listId,
            ids: inverse.itemIds,
          });
          if (inverse.announcement) {
            await must(this.writeApi, 'chat.delete', inverse.announcement).catch(() => undefined);
          }
          return {
            ok: true,
            message: 'Removed the action items (the empty list remains; Slack has no list delete).',
          };
        case 'not-reversible':
          return { ok: false, message: `Can't undo: ${inverse.reason}.` };
      }
    } catch (err) {
      const code = slackErrorCode(err) ?? 'unknown_error';
      return { ok: false, message: `Undo failed (${code}). ${slackErrorText(code)}` };
    }
  }
}

function slackErrorText(code: string): string {
  switch (code) {
    case 'not_in_channel':
    case 'channel_not_found':
      return 'Invite @Gemini to that channel first.';
    case 'msg_too_long':
      return 'The message was too long for Slack.';
    case 'time_in_past':
    case 'time_too_far':
      return 'That time is outside what Slack allows for scheduling.';
    case 'invalid_scheduled_message_id':
      return 'It already posted, so it can’t be cancelled.';
    case 'message_not_found':
      return 'It was already deleted.';
    case 'missing_scope':
      return 'The app is missing a Slack permission for this action — ask an admin to reinstall it.';
    case 'ratelimited':
      return 'Slack is rate-limiting the app; try again shortly.';
    default:
      return 'Slack rejected the change.';
  }
}
