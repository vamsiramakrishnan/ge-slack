import {
  INTENT_DESCRIPTIONS,
  IntentSchema,
  SCOPE_LABELS,
  describeTrigger,
  type Automation,
  type GroundSource,
  type SourceRef,
} from '@ge-slack/contracts';
import type {
  AnswerView,
  AutomationPlanView,
  AwaitingView,
  MemoryView,
  ConnectView,
  IdentityBadge,
  LandedView,
  LedgerEntry,
  NoticeKind,
  PlanView,
} from '@ge-slack/runtime';
import { ACTIONS, CALLBACKS } from './ids.js';

/** Block Kit is plain JSON; keep the type open but named. */
export type Block = Record<string, unknown>;

const SECTION_MAX = 2900;
const MAX_BLOCKS = 50;

export const plain = (text: string, emoji = true) => ({
  type: 'plain_text',
  text: text.slice(0, 150),
  emoji,
});
export const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });

/** Escape user/model text for mrkdwn (Slack's three control characters). */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function button(
  text: string,
  action_id: string,
  value?: string,
  style?: 'primary' | 'danger',
  url?: string,
): Block {
  return {
    type: 'button',
    text: plain(text),
    action_id,
    ...(value !== undefined ? { value: value.slice(0, 2000) } : {}),
    ...(style ? { style } : {}),
    ...(url ? { url } : {}),
  };
}

export function identityLine(id: IdentityBadge): string {
  return id.kind === 'user'
    ? `🔐 as you · ${esc(id.label)}`
    : '🏢 as Gemini service · shared sources only';
}

/** Numbered source chips: `[1] <uri|title>`; titles are untrusted text. */
export function citationElements(sources: SourceRef[]): Block[] {
  return sources.slice(0, 10).map((s, i) => {
    const title = esc(s.title.replace(/\s+/g, ' ').slice(0, 80));
    const safeUri = s.uri && /^https:\/\//.test(s.uri) && !/[|<>]/.test(s.uri) ? s.uri : undefined;
    return mrkdwn(safeUri ? `[${i + 1}] <${safeUri}|${title}>` : `[${i + 1}] ${title}`);
  });
}

/**
 * Split long markdown into `markdown` blocks (Slack renders standard markdown there, so model
 * output needs no mrkdwn translation). Each block ≤ ~3k chars, split on paragraph boundaries.
 */
export function markdownBlocks(text: string): Block[] {
  const out: Block[] = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((buf + '\n\n' + para).length > SECTION_MAX && buf) {
      out.push({ type: 'markdown', text: buf });
      buf = '';
    }
    buf = buf ? `${buf}\n\n${para}` : para;
    while (buf.length > SECTION_MAX) {
      out.push({ type: 'markdown', text: buf.slice(0, SECTION_MAX) });
      buf = buf.slice(SECTION_MAX);
    }
  }
  if (buf.trim()) out.push({ type: 'markdown', text: buf });
  return out;
}

/** Blocks appended after a streamed answer (or the whole answer when not streaming). */
export function answerBlocks(a: AnswerView, opts: { includeText: boolean }): Block[] {
  const blocks: Block[] = [];
  if (opts.includeText) blocks.push(...markdownBlocks(a.text || '_(no answer)_'));
  if (a.identity.notice)
    blocks.push({ type: 'context', elements: [mrkdwn(`ℹ️ ${esc(a.identity.notice)}`)] });
  for (const w of a.warnings.slice(0, 3))
    blocks.push({ type: 'context', elements: [mrkdwn(`⚠️ ${esc(w)}`)] });
  if (a.sources.length) blocks.push({ type: 'context', elements: citationElements(a.sources) });
  blocks.push({
    type: 'context',
    elements: [
      mrkdwn(
        `${identityLine(a.identity)}${a.via ? ` · via ${esc(a.via)}` : ''}${a.memoryNotes ? ` · 📌 ${a.memoryNotes} channel note${a.memoryNotes === 1 ? '' : 's'}` : ''} · ${a.sources.length} source${a.sources.length === 1 ? '' : 's'} · ${a.grounded ? 'grounded' : '*ungrounded* — no sources backed this answer'}`,
      ),
    ],
  });
  const actions: Block[] = [];
  if (a.shareable) actions.push(button('Share to channel', ACTIONS.share, a.turnId, 'primary'));
  if (a.authorizeUrl && isHttpsUrl(a.authorizeUrl)) {
    actions.push(
      button('Authorize sources', ACTIONS.agentAuthorize, a.turnId, undefined, a.authorizeUrl),
    );
  }
  if (a.followUps) actions.push(button('Draft follow-up', ACTIONS.followUp, a.turnId));
  for (const [i, q] of a.related.slice(0, 2).entries()) {
    actions.push(
      button(q.length > 70 ? `${q.slice(0, 69)}…` : q, `${ACTIONS.related}_${i}`, q.slice(0, 1900)),
    );
  }
  if (actions.length) blocks.push({ type: 'actions', elements: actions });
  blocks.push(feedbackBlock(a.turnId));
  return blocks.slice(0, MAX_BLOCKS);
}

export function feedbackBlock(turnId: string): Block {
  return {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: ACTIONS.feedback,
        positive_button: {
          text: plain('Good answer'),
          accessibility_label: 'Mark this answer helpful',
          value: `up:${turnId}`,
        },
        negative_button: {
          text: plain('Bad answer'),
          accessibility_label: 'Mark this answer unhelpful',
          value: `down:${turnId}`,
        },
      },
    ],
  };
}

const CLASS_BADGE: Record<string, string> = {
  'in-conversation': '',
  external: ' · _external_',
  personal: ' · _personal_',
};

export interface RenderOptions {
  /**
   * Use Slack's newest blocks (`data_table`, `plan`). Senders retry with `rich: false` if Slack
   * rejects them (`invalid_blocks`), so older clients/workspaces still get a usable card.
   */
  rich: boolean;
}

const isFindingsPlan = (p: PlanView) =>
  p.verb === 'review' && p.effects.length > 1 && p.effects.every((e) => e.kind === 'reply');

function richText(text: string, url?: string): Block {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [url ? { type: 'link', url, text } : { type: 'text', text }],
      },
    ],
  };
}

function findingText(preview: string): { severity: string; text: string } {
  const m = /^🔎 \*Finding(?: · (high|medium|low))?\*\s*/.exec(preview);
  return {
    severity: m?.[1] ?? '—',
    text: (m ? preview.slice(m[0].length) : preview).slice(0, 300) || '—',
  };
}

/** Review findings as a sortable table, one Post/Skip toggle per row. */
function findingsTable(p: PlanView, rich: boolean): Block[] {
  if (rich) {
    const header = ['#', 'Severity', 'Finding', 'Post?'].map((t) => ({
      type: 'raw_text',
      text: t,
    }));
    const rows = p.effects.slice(0, 200).map((e) => {
      const f = findingText(e.preview);
      return [
        { type: 'raw_number', value: e.index, text: String(e.index) },
        { type: 'raw_text', text: f.severity },
        { type: 'raw_text', text: f.text },
        {
          type: 'action_cell',
          element: {
            type: 'button',
            text: plain(e.skipped ? '✗ Skipped' : '✓ Post'),
            action_id: `${ACTIONS.findingToggle}_${e.index}`,
            value: `${p.planId}:${e.changeId}`,
            ...(e.skipped ? {} : { style: 'primary' }),
          },
          fallback: { type: 'raw_text', text: e.skipped ? 'Skipped' : 'Post' },
        },
      ];
    });
    return [
      {
        type: 'data_table',
        caption: `Review findings — tap a row's button to skip or include it`,
        page_size: 10,
        rows: [header, ...rows],
      },
    ];
  }
  return p.effects.slice(0, 20).map((e) => {
    const f = findingText(e.preview);
    return {
      type: 'section',
      text: mrkdwn(
        `${e.skipped ? '~' : ''}*${e.index}.* _${f.severity}_ · ${esc(f.text)}${e.skipped ? '~' : ''}`,
      ),
      accessory: button(
        e.skipped ? 'Include' : 'Skip',
        `${ACTIONS.findingToggle}_${e.index}`,
        `${p.planId}:${e.changeId}`,
      ),
    };
  });
}

export function planBlocks(p: PlanView, opts: RenderOptions = { rich: true }): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: mrkdwn(`*✦ ${esc(p.title)}*\n\`${esc(p.grammar).slice(0, 300)}\``),
    },
  ];
  if (p.steps.length) {
    blocks.push({
      type: 'context',
      elements: [mrkdwn(`*Plan:* ${p.steps.map(esc).join(' → ').slice(0, 2000)}`)],
    });
  }
  blocks.push({ type: 'divider' });
  if (isFindingsPlan(p)) {
    blocks.push(...findingsTable(p, opts.rich));
  } else {
    for (const e of p.effects.slice(0, 12)) {
      blocks.push({
        type: 'section',
        text: mrkdwn(
          `*${e.index}.* ${e.label}${CLASS_BADGE[e.approvalClass] ?? ''} · ${e.reversible ? 'reversible ↺' : '*not reversible*'}\n>${esc(e.preview)}`,
        ),
      });
    }
  }
  const program = p.effects.map((e) => e.line).join('\n');
  blocks.push({ type: 'section', text: mrkdwn(`\`\`\`${esc(program).slice(0, 2800)}\`\`\``) });
  if (p.sources.length) blocks.push({ type: 'context', elements: citationElements(p.sources) });
  blocks.push({
    type: 'context',
    elements: [
      mrkdwn(
        `${identityLine(p.identity)} · only <@${p.invokerId}> can approve · expires <!date^${Math.floor(Date.parse(p.expiresAt) / 1000)}^{time}|in 30 min>`,
      ),
    ],
  });
  const included = p.effects.filter((e) => !e.skipped).length;
  const approveLabel = isFindingsPlan(p)
    ? `Post ${included} finding${included === 1 ? '' : 's'}`
    : p.effects.length === 1
      ? 'Approve'
      : 'Approve all';
  blocks.push({
    type: 'actions',
    elements: p.dryRun
      ? [button('Close', ACTIONS.cancel, p.planId)]
      : [
          ...(included > 0 ? [button(approveLabel, ACTIONS.approve, p.planId, 'primary')] : []),
          button('Edit…', ACTIONS.edit, p.planId),
          button('Cancel', ACTIONS.cancel, p.planId, 'danger'),
        ],
  });
  return blocks.slice(0, MAX_BLOCKS);
}

type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

/** The approval card, turned into a live receipt with Slack's native `plan` block. */
function receipt(
  planId: string,
  phase: string,
  title: string,
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    output?: { text: string; url?: string };
  }>,
  footer: string,
  undo: Array<{ changeId: string; label: string }>,
  opts: RenderOptions,
): Block[] {
  const blocks: Block[] = [];
  if (opts.rich) {
    blocks.push({
      type: 'plan',
      // A new block_id per iteration, as Slack asks for updated plan blocks.
      block_id: `ge_plan_${planId}_${phase}`.slice(0, 255),
      title: title.slice(0, 200),
      tasks: tasks.slice(0, 50).map((t) => ({
        task_id: t.id,
        title:
          t.title
            .replace(/<[^>]*\|([^>]*)>/g, '$1')
            .replace(/<[^>]+>/g, '')
            .slice(0, 200) || 'Change',
        status: t.status,
        ...(t.output ? { output: richText(t.output.text, t.output.url) } : {}),
      })),
    });
  } else {
    const icon: Record<TaskStatus, string> = {
      pending: '○',
      in_progress: '◐',
      complete: '✅',
      error: '❌',
    };
    blocks.push({ type: 'section', text: mrkdwn(`*✦ ${esc(title)}*`) });
    for (const t of tasks.slice(0, 20)) {
      blocks.push({
        type: 'section',
        text: mrkdwn(
          `${icon[t.status]} ${t.title}${t.output ? ` · ${t.output.url ? `<${t.output.url}|${esc(t.output.text)}>` : esc(t.output.text)}` : ''}`,
        ),
      });
    }
  }
  if (undo.length) {
    blocks.push({
      type: 'actions',
      elements: undo.slice(0, 25).map((u, i) => button(`Undo ${i + 1}`, ACTIONS.undo, u.changeId)),
    });
  }
  blocks.push({ type: 'context', elements: [mrkdwn(footer)] });
  return blocks.slice(0, MAX_BLOCKS);
}

export function executingBlocks(p: PlanView, opts: RenderOptions = { rich: true }): Block[] {
  return receipt(
    p.planId,
    'executing',
    `Applying ${p.effects.filter((e) => !e.skipped).length} change(s)…`,
    p.effects
      .filter((e) => !e.skipped)
      .map((e) => ({ id: e.changeId, title: e.label, status: 'in_progress' as const })),
    `${identityLine(p.identity)} · approved by <@${p.invokerId}>`,
    [],
    opts,
  );
}

export function landedBlocks(
  l: LandedView,
  invokerId: string,
  opts: RenderOptions = { rich: true },
): Block[] {
  const applied = l.results.filter((r) => r.outcome === 'applied').length;
  const tasks = l.results.map((r) => ({
    id: r.changeId,
    title: r.label,
    status: (r.outcome === 'applied' ? 'complete' : 'error') as TaskStatus,
    output:
      r.outcome === 'applied'
        ? {
            text: r.note ?? (r.permalink ? 'View' : 'Done'),
            ...(r.permalink ? { url: r.permalink } : {}),
          }
        : {
            text:
              r.outcome === 'uncertain'
                ? 'Outcome unknown — check before retrying'
                : (r.error ?? 'Failed'),
          },
  }));
  const skipped = l.skipped ? ` · ${l.skipped} skipped` : '';
  return receipt(
    l.planId,
    'landed',
    `Applied ${applied}/${l.results.length}${skipped} · ${l.title}`,
    tasks,
    `✦ Applied by Gemini for <@${invokerId}> · ${identityLine(l.identity)} · App Home → Recent changes`,
    l.results.filter((r) => r.undoable).map((r) => ({ changeId: r.changeId, label: r.label })),
    opts,
  );
}

/** Footer attached to every message the bot lands (in addition to the metadata payload). */
export function provenanceFooter(p: {
  invoker: string;
  principal: string;
  sources: number;
  approval: 'human' | 'auto';
  automationId?: string;
  changeId: string;
}): Block {
  const who = p.principal.startsWith('service:') ? '🏢 as Gemini service' : '🔐 as the requester';
  const how = p.approval === 'auto' ? `automation ${p.automationId ?? ''}`.trim() : 'approved';
  return {
    type: 'context',
    elements: [
      mrkdwn(
        `✦ Drafted by Gemini for <@${p.invoker}> · ${who} · ${p.sources} source${p.sources === 1 ? '' : 's'} · ${how} · \`${p.changeId.slice(0, 16)}\``,
      ),
    ],
  };
}

export function connectBlocks(c: ConnectView): Block[] {
  const blocks: Block[] = [
    { type: 'section', text: mrkdwn(`*✦ Connect Gemini Enterprise*\n${esc(c.message)}`) },
  ];
  const actions: Block[] = [];
  if (c.connectUrl)
    actions.push(
      button(
        `Connect with ${c.providerName}`,
        ACTIONS.connect,
        c.resumeId ?? 'connect',
        'primary',
        c.connectUrl,
      ),
    );
  if (c.offerService && c.resumeId)
    actions.push(button('Answer with the Gemini service', ACTIONS.useService, c.resumeId));
  if (actions.length) blocks.push({ type: 'actions', elements: actions });
  if (c.offerService) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn(
          `🏢 The Gemini service uses shared sources only${c.serviceSources.length ? `: ${c.serviceSources.map(esc).join(' · ')}` : ''}.`,
        ),
      ],
    });
  }
  blocks.push({
    type: 'context',
    elements: [mrkdwn('Your request will continue automatically after you connect.')],
  });
  return blocks;
}

const NOTICE_ICON: Record<NoticeKind, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '❗',
  policy: '🛡️',
  denied: '🔒',
  clarify: '❓',
};

/** `/gemini memory` (EXPERIENCE §10): every note, who added it, and Forget. Private. */
export function memoryBlocks(m: MemoryView): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: mrkdwn(
        `*📌 Channel memory for <#${m.channel}>* · ${m.notes.length} of ${m.limit} notes\n` +
          'Answers in this channel use these notes as background. Add one with `/gemini remember "…"` or *Remember this* on a message.',
      ),
    },
  ];
  if (!m.notes.length) {
    blocks.push({ type: 'context', elements: [mrkdwn('_No notes yet._')] });
  }
  for (const n of m.notes.slice(0, 45)) {
    const source =
      n.permalink && /^https:\/\/[^\s|<>]+$/.test(n.permalink)
        ? ` · <${n.permalink}|from a message>`
        : '';
    const by = n.sourceUser ? `<@${n.author}> (said by <@${n.sourceUser}>)` : `<@${n.author}>`;
    blocks.push({
      type: 'section',
      text: mrkdwn(`*${n.n}.* ${esc(n.text)}\n_${by} · ${n.at.slice(0, 10)}${source}_`),
      accessory: button('Forget', ACTIONS.memoryForget, `${m.channel}:${n.id}`),
    });
  }
  if (m.forgotten.count) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn(
          `${m.forgotten.count} forgotten in the last 30 days${m.forgotten.lastBy ? ` · latest by <@${m.forgotten.lastBy}> on ${(m.forgotten.lastAt ?? '').slice(0, 10)}` : ''}`,
        ),
      ],
    });
  }
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * An agent paused for its invoker (ADR-0002). The card is private to the invoker; the runtime
 * also refuses anyone else's click.
 */
export function awaitingBlocks(a: AwaitingView): Block[] {
  const title = esc(a.agentTitle);
  const id = a.continuationId;
  const lead =
    a.reason === 'research-plan'
      ? `*${title} drafted a research plan.* Start it as is, or tell it what to change.`
      : a.reason === 'input-required'
        ? `*${title} needs an answer from you* to continue.`
        : `*${title} needs your authorization* before it can continue. Authorize it in Gemini Enterprise, then try again.`;
  const actions: Block[] =
    a.reason === 'research-plan'
      ? [
          button('Start research', ACTIONS.agentStart, id, 'primary'),
          button('Change the plan', ACTIONS.agentReply, id),
        ]
      : a.reason === 'input-required'
        ? [button('Reply', ACTIONS.agentReply, id, 'primary')]
        : [
            ...(a.authorizeUrl && isHttpsUrl(a.authorizeUrl)
              ? [button('Authorize', ACTIONS.agentAuthorize, id, 'primary', a.authorizeUrl)]
              : []),
            button('Try again', ACTIONS.agentRetry, id),
          ];
  return [
    { type: 'section', text: mrkdwn(`✦ ${lead}`) },
    { type: 'actions', elements: actions },
    {
      type: 'context',
      elements: [
        mrkdwn(
          a.reason === 'research-plan'
            ? 'Deep Research can take several minutes. Nothing runs until you start it; the report appears where you asked.'
            : 'Only you can continue this. It expires in an hour.',
        ),
      ],
    },
  ];
}

export function agentReplyModal(p: {
  continuationId: string;
  agentTitle: string;
  reason: AwaitingView['reason'];
}): Record<string, unknown> {
  const plan = p.reason === 'research-plan';
  return {
    type: 'modal',
    callback_id: CALLBACKS.agentReply,
    title: plain(plan ? 'Change the plan' : 'Reply to the agent'),
    submit: plain(plan ? 'Revise plan' : 'Send'),
    close: plain('Back'),
    private_metadata: p.continuationId,
    blocks: [
      {
        type: 'input',
        block_id: 'reply',
        label: plain(
          (plan ? `What should ${p.agentTitle} change?` : `Your answer for ${p.agentTitle}`).slice(
            0,
            150,
          ),
        ),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          multiline: true,
          max_length: 4000,
        },
      },
    ],
  };
}

function isHttpsUrl(u: string): boolean {
  return /^https:\/\/[^\s|<>]+$/.test(u);
}

export function noticeBlocks(kind: NoticeKind, text: string): Block[] {
  const lead = kind === 'clarify' ? '*Gemini needs a detail before it can do this:*\n' : '';
  return [{ type: 'section', text: mrkdwn(`${NOTICE_ICON[kind]} ${lead}${text.slice(0, 2900)}`) }];
}

export function automationPlanBlocks(a: AutomationPlanView): Block[] {
  return [
    { type: 'section', text: mrkdwn('*✦ Create this automation?*') },
    {
      type: 'section',
      fields: [
        mrkdwn(`*Trigger*\n${esc(describeTrigger(a.trigger))}`),
        mrkdwn(`*Action*\n\`${esc(a.grammar).slice(0, 300)}\``),
        mrkdwn(`*Runs as*\n${a.runAs === 'me' ? '🔐 you (offline access)' : '🏢 Gemini service'}`),
        mrkdwn(
          `*Posts to*\n${a.destination ? `<#${a.destination}>` : `<#${a.channelId}> (triggering thread)`}`,
        ),
        ...(a.nextRun
          ? [
              mrkdwn(
                `*Next run*\n<!date^${Math.floor(Date.parse(a.nextRun) / 1000)}^{date_short_pretty} {time}|${a.nextRun}>`,
              ),
            ]
          : []),
      ],
    },
    {
      type: 'context',
      elements: [
        mrkdwn(
          'Unattended runs may only reply in the triggering thread or post to the destination; anything else is sent to you for approval.',
        ),
      ],
    },
    {
      type: 'actions',
      elements: [
        button('Create', ACTIONS.autoCreate, a.pendingId, 'primary'),
        button('Cancel', ACTIONS.autoCancel, a.pendingId),
      ],
    },
  ];
}

// ------------------------------------------------------------------ progress (non-streaming)

export function progressBlocks(
  title: string,
  tasks: Array<{ title: string; status: string }>,
): Block[] {
  const icon = (s: string) =>
    s === 'complete' ? '✓' : s === 'error' ? '✗' : s === 'in_progress' ? '◐' : '○';
  return [
    { type: 'section', text: mrkdwn(`*✦ ${esc(title)}*`) },
    {
      type: 'context',
      elements: [
        mrkdwn(tasks.map((t) => `${icon(t.status)} ${esc(t.title)}`).join('\n') || '◐ Working…'),
      ],
    },
  ];
}

// ------------------------------------------------------------------ App Home

export interface HomeData {
  userId: string;
  linked?: { email: string; provider: string; allowUnattended: boolean };
  providerName: string;
  connectUrl?: string;
  serviceAccount?: string;
  automations: Automation[];
  ledger: LedgerEntry[];
  isAdmin: boolean;
  /** Admin insights lines (mrkdwn, content-free), when analytics is on. */
  insights?: string[];
  /** Your running background jobs (EXPERIENCE §10). */
  jobs?: Array<{ id: string; title: string; startedAt: string }>;
}

export function homeView(d: HomeData): Record<string, unknown> {
  const blocks: Block[] = [{ type: 'header', text: plain('Gemini Enterprise') }];
  if (d.linked) {
    blocks.push({
      type: 'section',
      text: mrkdwn(`🔐 Connected as *${esc(d.linked.email)}* via ${esc(d.providerName)}`),
      accessory: button('Disconnect', ACTIONS.disconnect, 'disconnect', 'danger'),
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'checkboxes',
          action_id: ACTIONS.allowUnattended,
          options: [
            { text: plain('Allow my automations to run as me while I’m away'), value: 'allow' },
          ],
          ...(d.linked.allowUnattended
            ? {
                initial_options: [
                  {
                    text: plain('Allow my automations to run as me while I’m away'),
                    value: 'allow',
                  },
                ],
              }
            : {}),
        },
      ],
    });
  } else {
    blocks.push({
      type: 'section',
      text: mrkdwn(
        '🔓 *Not connected.* Connect so Gemini answers with your licence and only sources you can open.',
      ),
      ...(d.connectUrl
        ? {
            accessory: button(
              `Connect with ${d.providerName}`,
              ACTIONS.connect,
              'home',
              'primary',
              d.connectUrl,
            ),
          }
        : {}),
    });
  }
  if (d.serviceAccount) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn(
          `🏢 Gemini service identity available where channel policy allows: \`${esc(d.serviceAccount)}\``,
        ),
      ],
    });
  }
  blocks.push(
    { type: 'divider' },
    { type: 'section', text: mrkdwn('*Quick start*') },
    {
      type: 'actions',
      elements: [
        button('Summarize a channel', ACTIONS.quickStart, 'summarize'),
        button('Catch me up', ACTIONS.quickStart, 'ask'),
        button('Draft an update', ACTIONS.quickStart, 'draft'),
      ],
    },
  );

  blocks.push(
    { type: 'divider' },
    ...(d.jobs?.length
      ? [
          { type: 'section', text: mrkdwn(`*Running for you (${d.jobs.length})*`) },
          ...d.jobs.slice(0, 10).map((j) => ({
            type: 'section',
            text: mrkdwn(
              `⏳ ${j.title}\n_started ${j.startedAt.slice(0, 16).replace('T', ' ')} UTC_`,
            ),
            accessory: button('Cancel', ACTIONS.jobCancel, j.id, 'danger'),
          })),
          { type: 'divider' },
        ]
      : []),
    { type: 'section', text: mrkdwn(`*Automations (${d.automations.length})*`) },
  );
  if (!d.automations.length) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn('None yet — try `/gemini automate "weekdays 9:00" summarize --to #digest`'),
      ],
    });
  }
  for (const a of d.automations.slice(0, 15)) {
    blocks.push({
      type: 'section',
      text: mrkdwn(
        `${esc(describeTrigger(a.trigger))} · \`${a.invocation.verb}\` in <#${a.channelId}>${a.destination ? ` → <#${a.destination}>` : ''} · ${a.runAs === 'me' ? '🔐 you' : '🏢 service'}${a.enabled ? '' : ' · *paused*'}${a.suspendedReason ? ` — ${esc(a.suspendedReason)}` : ''}`,
      ),
      accessory: {
        type: 'overflow',
        action_id: ACTIONS.autoToggle,
        options: [
          { text: plain(a.enabled ? 'Pause' : 'Resume'), value: `toggle:${a.id}` },
          ...(a.trigger.kind === 'schedule'
            ? [{ text: plain('Run now'), value: `run:${a.id}` }]
            : []),
          { text: plain('Delete'), value: `delete:${a.id}` },
        ],
      },
    });
  }

  blocks.push({ type: 'divider' }, { type: 'section', text: mrkdwn('*Recent changes*') });
  if (!d.ledger.length)
    blocks.push({
      type: 'context',
      elements: [mrkdwn('Nothing yet. Every change Gemini makes for you shows up here.')],
    });
  for (const e of d.ledger.slice(0, 10)) {
    const where = e.location?.permalink ? ` · <${e.location.permalink}|view>` : '';
    const state = e.undoneAt ? ' · _undone_' : e.outcome !== 'applied' ? ` · _${e.outcome}_` : '';
    const undoable =
      !e.undoneAt && e.outcome === 'applied' && e.inverse && e.inverse.op !== 'not-reversible';
    blocks.push({
      type: 'section',
      text: mrkdwn(
        `<!date^${Math.floor(Date.parse(e.at) / 1000)}^{date_short} {time}|${e.at}> ${e.label}${where} · ${e.approval === 'auto' ? 'automation' : 'approved'}${state}`,
      ),
      ...(undoable ? { accessory: button('Undo', ACTIONS.undo, e.changeId) } : {}),
    });
  }

  if (d.isAdmin) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn('*Admin* · channel identity policies and the service identity’s reach'),
        accessory: button('Channel policy…', ACTIONS.openPolicy, 'policy'),
      },
    );
    if (d.insights?.length) {
      blocks.push({
        type: 'section',
        text: mrkdwn(
          `*📊 Insights* — no message content, no user identities\n${d.insights.join('\n')}`,
        ),
        accessory: button('Export ledger (CSV)', ACTIONS.exportLedger, 'export'),
      });
    }
  }
  return { type: 'home', blocks: blocks.slice(0, 100) };
}

// ------------------------------------------------------------------ modals

export interface ComposerPrefill {
  verb?: string;
  instruction?: string;
  scope?: 'thread' | 'channel' | 'message' | 'none';
  channelId?: string;
  threadTs?: string;
  messageTs?: string;
  responseUrl?: string;
}

export function composerModal(
  prefill: ComposerPrefill,
  catalog: GroundSource[],
  serviceAllowed: boolean,
): Record<string, unknown> {
  const verbOptions = IntentSchema.options.map((v) => ({
    text: plain(`/${v} — ${INTENT_DESCRIPTIONS[v]}`.slice(0, 75)),
    value: v,
  }));
  const initialVerb = verbOptions.find((o) => o.value === (prefill.verb ?? 'ask'));
  const scopeOptions = (['thread', 'channel', 'message', 'none'] as const)
    .filter(
      (s) =>
        s === 'none' ||
        (s === 'thread'
          ? prefill.threadTs
          : s === 'message'
            ? prefill.messageTs
            : prefill.channelId),
    )
    .map((s) => ({ text: plain(s === 'none' ? 'Nothing — just ask' : SCOPE_LABELS[s]), value: s }));
  const initialScope = scopeOptions.find((o) => o.value === prefill.scope) ?? scopeOptions[0];
  const sourceOptions = [
    { text: plain('@unit — this channel’s sources'), value: 'unit' },
    { text: plain('@this — conversation only'), value: 'this' },
    ...catalog
      .slice(0, 98)
      .map((c) => ({ text: plain(`@${c.alias} — ${c.title}`.slice(0, 75)), value: c.alias })),
  ];
  return {
    type: 'modal',
    callback_id: CALLBACKS.composer,
    title: plain('Gemini'),
    submit: plain('Run'),
    close: plain('Cancel'),
    private_metadata: JSON.stringify({
      c: prefill.channelId,
      t: prefill.threadTs,
      m: prefill.messageTs,
      r: prefill.responseUrl,
    }).slice(0, 3000),
    blocks: [
      {
        type: 'input',
        block_id: 'verb',
        label: plain('What should Gemini do?'),
        element: {
          type: 'static_select',
          action_id: 'v',
          options: verbOptions,
          ...(initialVerb ? { initial_option: initialVerb } : {}),
        },
      },
      ...(scopeOptions.length
        ? [
            {
              type: 'input',
              block_id: 'scope',
              label: plain('On what?'),
              element: {
                type: 'static_select',
                action_id: 'v',
                options: scopeOptions,
                ...(initialScope ? { initial_option: initialScope } : {}),
              },
            },
          ]
        : []),
      {
        type: 'input',
        block_id: 'sources',
        optional: true,
        label: plain('Grounded on (@)'),
        element: {
          type: 'multi_static_select',
          action_id: 'v',
          options: sourceOptions,
          placeholder: plain('@unit by default'),
        },
      },
      {
        type: 'input',
        block_id: 'instruction',
        optional: true,
        label: plain('Instruction'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          multiline: true,
          max_length: 3000,
          ...(prefill.instruction ? { initial_value: prefill.instruction } : {}),
          placeholder: plain('e.g. focus on decisions and owners'),
        },
      },
      {
        type: 'input',
        block_id: 'runas',
        label: plain('Run as'),
        element: {
          type: 'radio_buttons',
          action_id: 'v',
          options: [
            { text: plain('🔐 Me'), value: 'me' },
            ...(serviceAllowed
              ? [{ text: plain('🏢 Gemini service (shared sources)'), value: 'service' }]
              : []),
          ],
          initial_option: { text: plain('🔐 Me'), value: 'me' },
        },
      },
      {
        type: 'input',
        block_id: 'visibility',
        label: plain('Who sees the answer?'),
        element: {
          type: 'radio_buttons',
          action_id: 'v',
          options: [
            { text: plain('Only me'), value: 'private' },
            { text: plain('Everyone in the conversation'), value: 'public' },
          ],
          initial_option: { text: plain('Only me'), value: 'private' },
        },
      },
      {
        type: 'context',
        elements: [
          mrkdwn(
            'Same as typing `/gemini <verb> [scope] [@sources] "instruction"` — buttons and shortcuts just fill this in.',
          ),
        ],
      },
    ],
  };
}

export function planEditModal(p: {
  planId: string;
  effects: Array<{ changeId: string; label: string; text: string }>;
}): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: CALLBACKS.planEdit,
    title: plain('Edit changes'),
    submit: plain('Approve edited'),
    close: plain('Back'),
    private_metadata: p.planId,
    blocks: p.effects.slice(0, 20).map((e) => ({
      type: 'input',
      block_id: e.changeId,
      label: plain(e.label.replace(/<[^>]+>/g, '').slice(0, 150) || 'Change'),
      element: {
        type: 'plain_text_input',
        action_id: 'v',
        multiline: true,
        initial_value: e.text.slice(0, 3000),
        max_length: 4000,
      },
    })),
  };
}

export function policyModal(
  channel: string | undefined,
  current:
    | { identity: string; serviceGrounds: string[]; serviceMayRead: boolean; autoApply: boolean }
    | undefined,
  catalog: GroundSource[],
): Record<string, unknown> {
  const identityOptions = [
    { text: plain('User only (default)'), value: 'user-only' },
    { text: plain('User preferred, service offered'), value: 'user-preferred' },
    { text: plain('Service only'), value: 'service-only' },
  ];
  const serviceSources = catalog
    .filter((c) => c.serviceAllowed)
    .map((c) => ({ text: plain(`@${c.alias} — ${c.title}`.slice(0, 75)), value: c.alias }));
  const flags = [
    { text: plain('Service may read this channel'), value: 'read' },
    { text: plain('Automations may auto-apply replies/posts'), value: 'auto' },
  ];
  return {
    type: 'modal',
    callback_id: CALLBACKS.policy,
    title: plain('Channel policy'),
    submit: plain('Save'),
    blocks: [
      {
        type: 'input',
        block_id: 'channel',
        label: plain('Channel'),
        element: {
          type: 'conversations_select',
          action_id: 'v',
          ...(channel ? { initial_conversation: channel } : {}),
          filter: { include: ['public', 'private'], exclude_bot_users: true },
        },
      },
      {
        type: 'input',
        block_id: 'identity',
        label: plain('Identity policy'),
        element: {
          type: 'static_select',
          action_id: 'v',
          options: identityOptions,
          initial_option: identityOptions.find(
            (o) => o.value === (current?.identity ?? 'user-only'),
          ),
        },
      },
      ...(serviceSources.length
        ? [
            {
              type: 'input',
              block_id: 'grounds',
              optional: true,
              label: plain('Sources the service may use here'),
              element: {
                type: 'multi_static_select',
                action_id: 'v',
                options: serviceSources,
                ...(current?.serviceGrounds.length
                  ? {
                      initial_options: serviceSources.filter((o) =>
                        current.serviceGrounds.includes(o.value),
                      ),
                    }
                  : {}),
              },
            },
          ]
        : []),
      {
        type: 'input',
        block_id: 'flags',
        optional: true,
        label: plain('Service reach'),
        element: {
          type: 'checkboxes',
          action_id: 'v',
          options: flags,
          ...(current?.serviceMayRead || current?.autoApply
            ? {
                initial_options: flags.filter((f) =>
                  f.value === 'read' ? current?.serviceMayRead : current?.autoApply,
                ),
              }
            : {}),
        },
      },
      {
        type: 'context',
        elements: [
          mrkdwn(
            'Slack Connect channels are always service-only. Private channels can be service-only only with this explicit setting.',
          ),
        ],
      },
    ],
  };
}
