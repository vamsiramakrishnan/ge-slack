import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { App, LogLevel } from '@slack/bolt';
import type { SlackApi } from '@ge-slack/slack-bridge';
import { loadConfig } from './config.js';
import { buildContainer, type Container } from './container.js';
import { register, routes } from './wiring.js';

/**
 * Entry point. HTTP mode (Cloud Run) when SLACK_SIGNING_SECRET is set; Socket Mode for local
 * development when SLACK_APP_TOKEN is set. Schedules tick via POST /cron/tick (Cloud Scheduler);
 * in Socket Mode a local interval drives the tick instead.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const socketMode = Boolean(cfg.SLACK_APP_TOKEN);
  // Filled after the app exists: the container needs the app's client, the app needs routes.
  const ref: { container?: Container; botUserId?: string } = {};

  const lazyRoutes = ['/healthz', '/oauth/callback', '/cron/tick'].map((path) => ({
    path,
    method: path === '/cron/tick' ? ['POST'] : ['GET'],
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const r = ref.container && routes(ref.container).find((x) => x.path === path);
      if (!r) {
        res.writeHead(503);
        res.end();
        return;
      }
      r.handler(req, res);
    },
  }));

  const app = new App({
    token: cfg.SLACK_BOT_TOKEN,
    ...(socketMode
      ? { socketMode: true, appToken: cfg.SLACK_APP_TOKEN! }
      : { signingSecret: cfg.SLACK_SIGNING_SECRET!, customRoutes: lazyRoutes }),
    logLevel: cfg.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
  });

  const api: SlackApi = {
    async call(method, args) {
      return (await app.client.apiCall(method, args)) as Awaited<ReturnType<SlackApi['call']>>;
    },
  };
  const container = await buildContainer(cfg, { api });
  ref.container = container;
  register(app, container, () => ref.botUserId);
  ref.botUserId = (await app.client.auth.test()).user_id;

  if (socketMode) {
    createServer((req, res) => {
      const route = lazyRoutes.find(
        (r) => req.url?.split('?')[0] === r.path && r.method.includes(req.method ?? ''),
      );
      if (route) route.handler(req, res);
      else {
        res.writeHead(404);
        res.end();
      }
    }).listen(cfg.PORT);
    await app.start();
    const c = container;
    setInterval(() => {
      void c.engine.tick(c.orch, cfg.SLACK_TEAM_ID, c.unattendedSink).catch(() => undefined);
    }, 60_000);
  } else {
    await app.start(cfg.PORT);
  }
  console.log(`[ge-slack] running (${socketMode ? 'socket mode' : 'http'}) on :${cfg.PORT}`);
}

main().catch((err) => {
  console.error(`[ge-slack] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
