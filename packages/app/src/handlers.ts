import {
  parseCommand,
  type Ground,
  type Intent,
  type Invocation,
  type Origin,
  IntentSchema,
} from '@ge-slack/contracts';
import {
  composerModal,
  homeView,
  planEditModal,
  policyModal,
  type ComposerPrefill,
} from '@ge-slack/slack-bridge';
import type { Container } from './container.js';

/**
 * Slack-agnostic handler bodies (normalized inputs → orchestrator). `wiring.ts` adapts Bolt's
 * payloads to these, so the logic is testable without a Slack connection.
 */

export interface SlashInput {
  teamId: string;
  userId: string;
  channelId: string;
  text: string;
  responseUrl: string;
  triggerId: string;
  isExtShared?: boolean;
}

export async function onSlash(c: Container, s: SlashInput): Promise<void> {
  const parsed = parseCommand(s.text);
  const origin: Origin = {
    entry: 'slash',
    teamId: s.teamId,
    userId: s.userId,
    channelId: s.channelId,
    responseUrl: s.responseUrl,
    triggerId: s.triggerId,
    ...(s.isExtShared ? { externallyShared: true } : {}),
  };
  if (parsed.kind === 'compose') {
    await openComposer(
      c,
      s.triggerId,
      { channelId: s.channelId, responseUrl: s.responseUrl, scope: 'channel' },
      s.userId,
    );
    return;
  }
  const inv =
    parsed.kind === 'invoke' || parsed.kind === 'automate' ? parsed.invocation : undefined;
  await c.orch.handle(parsed, origin, c.sinkFor(origin, inv));
}

export interface MessageEventInput {
  teamId: string;
  userId: string;
  channelId: string;
  ts: string;
  threadTs?: string;
  text: string;
}

/** `@Gemini …` in a channel or thread. The bot mention is stripped; replies go in the thread. */
export async function onMention(
  c: Container,
  e: MessageEventInput,
  botUserId: string | undefined,
): Promise<void> {
  const text = botUserId
    ? e.text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), ' ')
    : e.text;
  const parsed = parseCommand(text.trim() || 'help');
  const origin: Origin = {
    entry: 'mention',
    teamId: e.teamId,
    userId: e.userId,
    channelId: e.channelId,
    messageTs: e.ts,
    ...(e.threadTs ? { threadTs: e.threadTs } : {}),
  };
  if (parsed.kind === 'compose') return;
  const inv =
    parsed.kind === 'invoke' || parsed.kind === 'automate' ? parsed.invocation : undefined;
  await c.orch.handle(parsed, origin, c.sinkFor(origin, inv));
}

/** Agent Messages tab / DM: conversational; each top-level message starts a session thread. */
export async function onDirectMessage(c: Container, e: MessageEventInput): Promise<void> {
  const parsed = parseCommand(e.text);
  const origin: Origin = {
    entry: 'agent-dm',
    teamId: e.teamId,
    userId: e.userId,
    channelId: e.channelId,
    messageTs: e.ts,
    threadTs: e.threadTs ?? e.ts,
  };
  if (parsed.kind === 'compose') return;
  const inv =
    parsed.kind === 'invoke' || parsed.kind === 'automate' ? parsed.invocation : undefined;
  await c.orch.handle(parsed, origin, c.sinkFor(origin, inv));
}

// ------------------------------------------------------------------ composer

export async function openComposer(
  c: Container,
  triggerId: string,
  prefill: ComposerPrefill,
  userId: string,
): Promise<void> {
  const policy = prefill.channelId
    ? await c.workspace.channelPolicy(c.cfg.SLACK_TEAM_ID, prefill.channelId)
    : undefined;
  const serviceAllowed =
    c.broker.serviceConfigured && policy !== undefined && policy.identity !== 'user-only';
  void userId;
  await c.api.call('views.open', {
    trigger_id: triggerId,
    view: composerModal(prefill, await c.workspace.catalog(c.cfg.SLACK_TEAM_ID), serviceAllowed),
  });
}

type ViewValues = Record<
  string,
  Record<
    string,
    {
      selected_option?: { value: string } | null;
      selected_options?: Array<{ value: string }>;
      value?: string | null;
    }
  >
>;

export function invocationFromComposer(
  values: ViewValues,
  meta: { c?: string; t?: string; m?: string },
): Invocation {
  const verbRaw = values.verb?.v?.selected_option?.value ?? 'ask';
  const verb: Intent = IntentSchema.safeParse(verbRaw).success ? (verbRaw as Intent) : 'ask';
  const scopeChoice = values.scope?.v?.selected_option?.value ?? 'none';
  const grounds: Ground[] = (values.sources?.v?.selected_options ?? []).map((o) =>
    o.value === 'unit' || o.value === 'this'
      ? { kind: o.value }
      : { kind: 'alias', alias: o.value },
  );
  const runAs = values.runas?.v?.selected_option?.value === 'service' ? 'service' : undefined;
  const visibility =
    values.visibility?.v?.selected_option?.value === 'public' ? 'public' : 'private';
  let scope: Invocation['scope'];
  if (scopeChoice === 'thread' && meta.c && meta.t)
    scope = { kind: 'thread', channel: meta.c, ts: meta.t };
  else if (scopeChoice === 'message' && meta.c && meta.m)
    scope = { kind: 'message', channel: meta.c, ts: meta.m };
  else if (scopeChoice === 'channel' && meta.c) scope = { kind: 'channel', channel: meta.c };
  return {
    verb,
    inferredVerb: false,
    ...(scope ? { scope } : {}),
    grounds: grounds.some((g) => g.kind === 'this') ? [{ kind: 'this' }] : grounds,
    people: [],
    from: [],
    instruction: (values.instruction?.v?.value ?? '').slice(0, 4000),
    flags: { visibility, ...(runAs ? { as: runAs } : {}) },
  };
}

export async function onComposerSubmit(
  c: Container,
  userId: string,
  values: ViewValues,
  privateMetadata: string,
): Promise<void> {
  let meta: { c?: string; t?: string; m?: string; r?: string } = {};
  try {
    meta = JSON.parse(privateMetadata || '{}');
  } catch {
    /* empty */
  }
  const inv = invocationFromComposer(values, meta);
  let channelId = meta.c;
  if (!channelId) {
    // No conversation: answer in the user's DM with the app.
    const r = await c.api.call('conversations.open', { users: userId });
    channelId = (r.channel as { id?: string } | undefined)?.id;
  }
  const origin: Origin = {
    entry: 'modal',
    teamId: c.cfg.SLACK_TEAM_ID,
    userId,
    ...(channelId ? { channelId } : {}),
    ...(meta.t ? { threadTs: meta.t } : {}),
    ...(meta.m ? { messageTs: meta.m } : {}),
    ...(meta.r && /^https:\/\/hooks\.slack\.com\//.test(meta.r) ? { responseUrl: meta.r } : {}),
  };
  await c.orch.run(inv, origin, c.sinkFor(origin, inv));
}

// ------------------------------------------------------------------ App Home

export async function publishHome(c: Container, userId: string): Promise<void> {
  const team = c.cfg.SLACK_TEAM_ID;
  const [linked, automations, ledger, isAdmin] = await Promise.all([
    c.broker.getLinked(team, userId),
    c.engine.list(team, userId),
    c.stores.recent(team, userId, 10),
    isWorkspaceAdmin(c, userId),
  ]);
  const connectUrl = linked
    ? undefined
    : await c.linker.start({ teamId: team, slackUserId: userId });
  await c.api.call('views.publish', {
    user_id: userId,
    view: homeView({
      userId,
      ...(linked
        ? {
            linked: {
              email: linked.email,
              provider: linked.provider,
              allowUnattended: linked.allowUnattended,
            },
          }
        : {}),
      providerName: c.cfg.IDP_DISPLAY_NAME,
      ...(connectUrl ? { connectUrl } : {}),
      ...(c.broker.serviceAccount ? { serviceAccount: c.broker.serviceAccount } : {}),
      automations,
      ledger,
      isAdmin,
    }),
  });
}

export async function isWorkspaceAdmin(c: Container, userId: string): Promise<boolean> {
  try {
    const r = await c.api.call('users.info', { user: userId });
    const u = r.user as { is_admin?: boolean; is_owner?: boolean } | undefined;
    return Boolean(u?.is_admin || u?.is_owner);
  } catch {
    return false;
  }
}

export async function openPolicy(
  c: Container,
  triggerId: string,
  userId: string,
  channel?: string,
): Promise<void> {
  if (!(await isWorkspaceAdmin(c, userId))) return;
  const current = channel
    ? await c.workspace.channelPolicy(c.cfg.SLACK_TEAM_ID, channel)
    : undefined;
  await c.api.call('views.open', {
    trigger_id: triggerId,
    view: policyModal(channel, current, await c.workspace.catalog(c.cfg.SLACK_TEAM_ID)),
  });
}

/** Admin-only; private channels need the explicit checkbox to become service-readable. */
export async function onPolicySubmit(
  c: Container,
  userId: string,
  values: ViewValues,
): Promise<string | undefined> {
  if (!(await isWorkspaceAdmin(c, userId)))
    return 'Only workspace admins can change channel policy.';
  const channel = (values.channel?.v as unknown as { selected_conversation?: string })
    ?.selected_conversation;
  if (!channel) return 'Pick a channel.';
  const identity = values.identity?.v?.selected_option?.value;
  if (identity !== 'user-only' && identity !== 'user-preferred' && identity !== 'service-only')
    return 'Pick a policy.';
  const flags = new Set((values.flags?.v?.selected_options ?? []).map((o) => o.value));
  const serviceGrounds = (values.grounds?.v?.selected_options ?? []).map((o) => o.value);
  const info = await c.surface.conversationInfo(channel);
  if (info.isExtShared && identity !== 'service-only') {
    return 'Slack Connect channels must be service-only.';
  }
  await c.workspace.setChannelPolicy(c.cfg.SLACK_TEAM_ID, channel, {
    identity,
    serviceGrounds,
    serviceMayRead: flags.has('read'),
    autoApply: flags.has('auto'),
  });
  return undefined;
}

export async function openPlanEditor(
  c: Container,
  triggerId: string,
  planId: string,
  userId: string,
): Promise<string | undefined> {
  const p = await c.stores.getPlan(planId);
  if (!p) return 'This plan expired.';
  if (p.invokerId !== userId) return `Only <@${p.invokerId}> can edit this plan.`;
  const effects = p.effects.flatMap((e) => {
    const text =
      'text' in e.params ? e.params.text : 'markdown' in e.params ? e.params.markdown : undefined;
    return text === undefined ? [] : [{ changeId: e.changeId, label: e.label, text }];
  });
  await c.api.call('views.open', {
    trigger_id: triggerId,
    view: planEditModal({ planId, effects }),
  });
  return undefined;
}
