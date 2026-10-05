import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App, BlockAction } from '@slack/bolt';
import type { Origin } from '@ge-slack/contracts';
import { ACTIONS, CALLBACKS, WORKFLOW_STEPS } from '@ge-slack/slack-bridge';
import { safeMessage } from '@ge-slack/runtime';
import { runWorkflowStep } from '@ge-slack/automations';
import type { Container } from './container.js';
import {
  onComposerSubmit,
  onDirectMessage,
  onMention,
  onPolicySubmit,
  onSlash,
  openComposer,
  openPlanEditor,
  openPolicy,
  publishHome,
} from './handlers.js';

type Values = Parameters<typeof onComposerSubmit>[2];

/** Errors inside handlers are logged without payloads (no message content, no tokens). */
function guard<T extends unknown[]>(name: string, fn: (...a: T) => Promise<void>) {
  return async (...a: T) => {
    try {
      await fn(...a);
    } catch (err) {
      console.error(`[ge-slack] ${name} failed: ${safeMessage(err)}`);
    }
  };
}

function actionValue(body: BlockAction): string {
  const a = body.actions[0] as { value?: string; selected_option?: { value: string } } | undefined;
  return a?.value ?? a?.selected_option?.value ?? '';
}

/** Origin for a button click: ephemeral replies go back through the action's response_url. */
function clickOrigin(c: Container, body: BlockAction): Origin {
  const channelId = body.channel?.id ?? body.container?.channel_id;
  const threadTs = (body.message as { thread_ts?: string } | undefined)?.thread_ts;
  return {
    entry: 'button',
    teamId: c.cfg.SLACK_TEAM_ID,
    userId: body.user.id,
    ...(channelId ? { channelId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(body.response_url ? { responseUrl: body.response_url } : {}),
  };
}

export function register(app: App, c: Container, botUserId: () => string | undefined): void {
  const team = c.cfg.SLACK_TEAM_ID;

  // ---------------------------------------------------------------- entry points
  app.command('/gemini', async ({ command, ack }) => {
    await ack(); // within 3s; the work continues asynchronously
    await guard('slash', onSlash)(c, {
      teamId: command.team_id,
      userId: command.user_id,
      channelId: command.channel_id,
      text: command.text,
      responseUrl: command.response_url,
      triggerId: command.trigger_id,
    });
  });

  app.event('app_mention', async ({ event }) => {
    if (!event.user) return;
    await guard('mention', onMention)(
      c,
      {
        teamId: team,
        userId: event.user,
        channelId: event.channel,
        ts: event.ts,
        ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
        text: event.text,
      },
      botUserId(),
    );
  });

  app.message(async ({ message }) => {
    const m = message as {
      subtype?: string;
      bot_id?: string;
      user?: string;
      channel: string;
      channel_type?: string;
      ts: string;
      thread_ts?: string;
      text?: string;
      team?: string;
    };
    const fromBot = Boolean(m.bot_id) || m.subtype === 'bot_message';
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') return;
    if (m.channel_type === 'im') {
      if (fromBot || !m.user) return;
      await guard('dm', onDirectMessage)(c, {
        teamId: team,
        userId: m.user,
        channelId: m.channel,
        ts: m.ts,
        ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
        text: m.text ?? '',
      });
      return;
    }
    // Mentions are handled by app_mention; keyword triggers see every other human message.
    const bot = botUserId();
    if (bot && m.text?.includes(`<@${bot}`)) return;
    await guard('keyword', async () => {
      await c.engine.onMessage(
        c.orch,
        {
          teamId: team,
          channel: m.channel,
          ts: m.ts,
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
          text: m.text ?? '',
          ...(m.user ? { userId: m.user } : {}),
          fromBot,
        },
        c.unattendedSink,
      );
    })();
  });

  app.event('reaction_added', async ({ event }) => {
    if (event.item.type !== 'message') return;
    await guard('reaction', async () => {
      await c.engine.onReaction(
        c.orch,
        {
          teamId: team,
          channel: event.item.channel,
          ts: event.item.ts,
          emoji: event.reaction.replace(/::skin-tone-\d$/, ''),
          userId: event.user,
        },
        c.unattendedSink,
      );
    })();
  });

  app.event('app_home_opened', async ({ event }) => {
    if (event.tab === 'home') await guard('home', publishHome)(c, event.user);
  });

  // ---------------------------------------------------------------- shortcuts
  const messageShortcut = (callbackId: string, verb: string, instruction?: string) =>
    app.shortcut(callbackId, async ({ shortcut, ack }) => {
      await ack();
      if (shortcut.type !== 'message_action') return;
      const threadTs =
        (shortcut.message as { thread_ts?: string }).thread_ts ?? shortcut.message.ts;
      await guard('message-shortcut', openComposer)(
        c,
        shortcut.trigger_id,
        {
          verb,
          ...(instruction ? { instruction } : {}),
          scope: verb === 'summarize' || verb === 'review' ? 'thread' : 'message',
          channelId: shortcut.channel.id,
          threadTs,
          messageTs: shortcut.message.ts,
          responseUrl: shortcut.response_url,
        },
        shortcut.user.id,
      );
    });
  messageShortcut(CALLBACKS.messageAsk, 'ask');
  messageShortcut(CALLBACKS.messageSummarize, 'summarize');
  messageShortcut(CALLBACKS.messageDraftReply, 'draft', 'a reply to this message');
  messageShortcut(CALLBACKS.messageReview, 'review');
  messageShortcut(CALLBACKS.messageCanvas, 'draft', 'turn this thread into a canvas');

  app.shortcut(CALLBACKS.globalNew, async ({ shortcut, ack }) => {
    await ack();
    await guard('global-shortcut', openComposer)(
      c,
      shortcut.trigger_id,
      { scope: 'none' },
      shortcut.user.id,
    );
  });

  // ---------------------------------------------------------------- views
  app.view(CALLBACKS.composer, async ({ ack, body, view }) => {
    await ack();
    await guard('composer', onComposerSubmit)(
      c,
      body.user.id,
      view.state.values as unknown as Values,
      view.private_metadata,
    );
  });

  app.view(CALLBACKS.planEdit, async ({ ack, body, view }) => {
    await ack();
    const edits = Object.fromEntries(
      Object.entries(view.state.values).map(([changeId, v]) => [
        changeId,
        String((v.v as { value?: string }).value ?? ''),
      ]),
    );
    const sinkOrigin: Origin = { entry: 'button', teamId: team, userId: body.user.id };
    await guard('plan-edit', () =>
      c.orch.approve(view.private_metadata, body.user.id, c.sinkFor(sinkOrigin), edits),
    )();
  });

  app.view(CALLBACKS.policy, async ({ ack, body, view }) => {
    const error = await onPolicySubmit(
      c,
      body.user.id,
      view.state.values as unknown as Values,
    ).catch(() => 'Could not save.');
    if (error) await ack({ response_action: 'errors', errors: { channel: error } });
    else await ack();
  });

  // ---------------------------------------------------------------- buttons
  const onAction = (id: string | RegExp, fn: (body: BlockAction) => Promise<void>) =>
    app.action(id, async ({ ack, body }) => {
      await ack();
      await guard(`action:${String(id)}`, fn)(body as BlockAction);
    });

  onAction(ACTIONS.approve, (b) =>
    c.orch.approve(actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b))),
  );
  onAction(ACTIONS.cancel, (b) =>
    c.orch.cancel(actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b))),
  );
  onAction(ACTIONS.edit, async (b) => {
    const err = await openPlanEditor(c, b.trigger_id, actionValue(b), b.user.id);
    if (err) await c.sinkFor(clickOrigin(c, b)).notice('denied', err);
  });
  onAction(ACTIONS.share, (b) =>
    c.orch.share(actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b))),
  );
  onAction(ACTIONS.useService, (b) =>
    c.orch.resume(actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b)), true),
  );
  onAction(ACTIONS.undo, (b) =>
    c.orch.undo(team, actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b))),
  );
  onAction(ACTIONS.connect, async () => {
    /* URL button: Slack opens the IdP; nothing to do server-side. */
  });
  onAction(ACTIONS.feedback, async (b) => {
    const v = actionValue(b);
    const [dir, turnId] = v.split(':');
    if (turnId && (dir === 'up' || dir === 'down'))
      await c.stores.recordFeedback(
        team,
        turnId,
        b.user.id,
        dir === 'up' ? 'positive' : 'negative',
      );
  });
  onAction(ACTIONS.followUp, async (b) => {
    const a = await c.stores.getAnswer(actionValue(b));
    if (!a || a.invokerId !== b.user.id) return;
    await openComposer(
      c,
      b.trigger_id,
      {
        verb: 'draft',
        instruction: 'a follow-up based on the answer above',
        scope: a.origin.threadTs ? 'thread' : 'channel',
        ...(a.origin.channelId ? { channelId: a.origin.channelId } : {}),
        ...(a.origin.threadTs ? { threadTs: a.origin.threadTs } : {}),
      },
      b.user.id,
    );
  });
  onAction(new RegExp(`^${ACTIONS.related}_\\d$`), async (b) => {
    const origin = clickOrigin(c, b);
    const question = actionValue(b).slice(0, 1900);
    const inv = {
      verb: 'ask' as const,
      inferredVerb: false,
      grounds: [],
      people: [],
      from: [],
      instruction: question,
      flags: {},
    };
    await c.orch.run(inv, origin, c.sinkFor(origin, inv));
  });
  onAction(ACTIONS.autoCreate, (b) =>
    c.orch.confirmAutomation(actionValue(b), b.user.id, c.sinkFor(clickOrigin(c, b))),
  );
  onAction(ACTIONS.autoCancel, async (b) => {
    await c.stores.takeAutomationDraft(actionValue(b));
    await c.sinkFor(clickOrigin(c, b)).notice('info', 'Automation not created.');
  });
  onAction(ACTIONS.autoToggle, async (b) => {
    const [op, id] = actionValue(b).split(':');
    if (!id) return;
    const msg =
      op === 'run'
        ? await c.engine.runNow(c.orch, team, id, b.user.id, c.unattendedSink)
        : await c.engine.manage(team, id, b.user.id, op === 'delete' ? 'delete' : 'toggle');
    await c.api.call('chat.postMessage', { channel: b.user.id, text: msg });
    await publishHome(c, b.user.id);
  });
  onAction(ACTIONS.allowUnattended, async (b) => {
    const a = b.actions[0] as { selected_options?: unknown[] };
    await c.broker.setAllowUnattended(team, b.user.id, (a.selected_options ?? []).length > 0);
    await publishHome(c, b.user.id);
  });
  onAction(ACTIONS.disconnect, async (b) => {
    await c.broker.unlink(team, b.user.id);
    await c.engine.suspendOwner(team, b.user.id, 'owner disconnected');
    await publishHome(c, b.user.id);
  });
  onAction(ACTIONS.quickStart, (b) =>
    openComposer(c, b.trigger_id, { verb: actionValue(b), scope: 'none' }, b.user.id),
  );
  onAction(ACTIONS.openPolicy, (b) => openPolicy(c, b.trigger_id, b.user.id));

  // ---------------------------------------------------------------- Workflow Builder steps
  for (const step of Object.values(WORKFLOW_STEPS)) {
    app.function(step, async ({ inputs, complete, fail }) => {
      // Slack-attested interactor (slack#/types/interactivity input), never a free-form user input.
      const interactivity = (inputs as { interactivity?: { interactor?: { id?: string } } })
        .interactivity;
      const r = await runWorkflowStep(
        c.orch,
        step,
        team,
        interactivity?.interactor?.id,
        inputs as Record<string, string>,
      ).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message.slice(0, 200) : 'failed',
      }));
      if (r.ok) await complete({ outputs: { ...r.outputs } });
      else await fail({ error: r.error });
    });
  }
}

// -------------------------------------------------------------------- HTTP routes

function html(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  const e = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)}</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.4rem">${e(title)}</h1><p>${e(body)}</p></body>`,
  );
}

export function routes(c: Container) {
  return [
    {
      path: '/healthz',
      method: ['GET'],
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      },
    },
    {
      path: '/oauth/callback',
      method: ['GET'],
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const state = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          if (!state || !code) {
            html(
              res,
              400,
              'Sign-in was not completed',
              'Return to Slack and run /gemini connect again.',
            );
            return;
          }
          const outcome = await c.linker
            .complete(state, code, (_t, u) => c.surface.userEmail(u))
            .catch(() => ({
              ok: false as const,
              reason: 'idp-error' as const,
              message: 'Sign-in failed.',
            }));
          if (!outcome.ok) {
            html(res, 400, 'Could not connect', outcome.message);
            return;
          }
          html(
            res,
            200,
            'Connected to Gemini Enterprise',
            'You can close this tab and return to Slack.',
          );
          await publishHome(c, outcome.slackUserId).catch(() => undefined);
          if (outcome.resumeId) {
            const pending = await c.stores.takeResume(outcome.resumeId);
            if (pending && pending.origin.userId === outcome.slackUserId) {
              // Ephemeral response_urls may have expired; resume in the user's DM to be safe.
              const dm = await c.api.call('conversations.open', { users: outcome.slackUserId });
              const dmId = (dm.channel as { id?: string } | undefined)?.id;
              const origin: Origin = { ...pending.origin };
              const sink = dmId
                ? c.sinkFor(
                    {
                      entry: 'agent-dm',
                      teamId: origin.teamId,
                      userId: origin.userId,
                      channelId: dmId,
                      messageTs: String(Date.now() / 1000),
                    },
                    pending.invocation,
                  )
                : c.sinkFor(origin, pending.invocation);
              await c.orch.run(pending.invocation, origin, sink).catch(() => undefined);
            }
          }
        })();
      },
    },
    {
      path: '/cron/tick',
      method: ['POST'],
      handler: (req: IncomingMessage, res: ServerResponse) => {
        const secret = c.cfg.GE_CRON_SECRET;
        const given = String(req.headers['x-ge-cron-secret'] ?? '');
        const ok =
          secret !== undefined &&
          given.length === secret.length &&
          timingSafeEqual(Buffer.from(given), Buffer.from(secret));
        if (!ok) {
          res.writeHead(401);
          res.end();
          return;
        }
        void c.engine
          .tick(c.orch, c.cfg.SLACK_TEAM_ID, c.unattendedSink)
          .then((ran) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ran: ran.length }));
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
      },
    },
  ];
}
