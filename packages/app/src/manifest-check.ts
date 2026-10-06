import { CALLBACKS, WORKFLOW_STEPS } from '@ge-slack/slack-bridge';

/**
 * Static checks that the Slack manifest matches what the bot wires (CI, `bun run manifest:check`).
 * Drift here fails silently in Slack — an event never delivered, a shortcut that 404s — so it is
 * caught before install instead.
 */

/** Scopes the bridge calls rely on (Slack API method → scope, see slack-bridge/surface.ts). */
export const REQUIRED_BOT_SCOPES = [
  'app_mentions:read',
  'assistant:write', // chat.startStream, assistant.threads.*, agent sessions
  'bookmarks:write',
  'canvases:read', // canvases.sections.lookup / getContent
  'canvases:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'groups:history',
  'groups:read',
  'im:history',
  'im:write',
  'lists:write', // action items
  'reactions:write',
  'search:read.public', // Real-time Search (assistant.search.context)
  'users:read',
  'users:read.email', // email binding (ADR-0001 §3)
];

/** Scopes deliberately not requested (security review L10: permalinks use the team domain). */
export const FORBIDDEN_BOT_SCOPES = ['team:read', 'chat:write.customize', 'admin'];

export interface ManifestFacts {
  /** Events registered with `app.event(...)` plus message events. */
  wiredEvents: string[];
}

type Json = Record<string, unknown>;

export function checkManifest(manifest: unknown, facts: ManifestFacts): string[] {
  const errors: string[] = [];
  const m = (manifest ?? {}) as Json;
  const features = (m.features ?? {}) as Json;
  const settings = (m.settings ?? {}) as Json;
  const scopes = (((m.oauth_config as Json | undefined)?.scopes as Json | undefined)?.bot ??
    []) as string[];

  for (const s of REQUIRED_BOT_SCOPES) {
    if (!scopes.includes(s)) errors.push(`missing bot scope ${s}`);
  }
  for (const s of scopes) {
    if (FORBIDDEN_BOT_SCOPES.some((f) => s === f || s.startsWith(`${f}.`))) {
      errors.push(`bot scope ${s} must not be requested`);
    }
  }

  const commands = (features.slash_commands ?? []) as Json[];
  const gemini = commands.find((c) => c.command === '/gemini');
  if (!gemini) errors.push('slash command /gemini is not declared');
  else if (gemini.should_escape !== true) {
    errors.push('/gemini must set should_escape: true (the grammar parses <#C…> and <@U…>)');
  }

  const shortcutIds = ((features.shortcuts ?? []) as Json[]).map((s) => String(s.callback_id));
  const expectedShortcuts = [
    CALLBACKS.globalNew,
    CALLBACKS.messageAsk,
    CALLBACKS.messageSummarize,
    CALLBACKS.messageDraftReply,
    CALLBACKS.messageReview,
    CALLBACKS.messageCanvas,
  ];
  for (const id of expectedShortcuts) {
    if (!shortcutIds.includes(id)) errors.push(`shortcut ${id} is wired but not declared`);
  }
  for (const id of shortcutIds) {
    if (!expectedShortcuts.includes(id as (typeof expectedShortcuts)[number])) {
      errors.push(`shortcut ${id} is declared but not wired`);
    }
  }

  if (!features.agent_view) errors.push('features.agent_view is required (agent DM entry)');
  const home = (features.app_home ?? {}) as Json;
  if (home.home_tab_enabled !== true) errors.push('App Home tab must be enabled (ledger, policy)');
  if (home.messages_tab_enabled !== true) errors.push('Messages tab must be enabled (agent DM)');

  const events = ((settings.event_subscriptions as Json | undefined)?.bot_events ?? []) as string[];
  for (const e of facts.wiredEvents) {
    if (!events.includes(e)) errors.push(`event ${e} is wired but not subscribed`);
  }
  if (Object.keys((m.functions ?? {}) as Json).length && !events.includes('function_executed')) {
    errors.push('custom steps need the function_executed event');
  }

  const functions = (m.functions ?? {}) as Record<string, Json>;
  for (const step of Object.values(WORKFLOW_STEPS)) {
    const fn = functions[step];
    if (!fn) {
      errors.push(`workflow step ${step} is wired but not declared`);
      continue;
    }
    const input = fn.input_parameters as Json | undefined;
    const props = (input?.properties ?? {}) as Record<string, Json>;
    const required = (input?.required ?? []) as string[];
    // Security review H2: the runner is the Slack-attested interactor, never a free-form user id.
    if (props.interactivity?.type !== 'slack#/types/interactivity') {
      errors.push(`workflow step ${step} needs an interactivity input`);
    } else if (!required.includes('interactivity')) {
      errors.push(`workflow step ${step} must require its interactivity input`);
    }
  }
  for (const name of Object.keys(functions)) {
    if (!Object.values(WORKFLOW_STEPS).includes(name as never)) {
      errors.push(`function ${name} is declared but not wired`);
    }
  }
  if (Object.keys(functions).length && settings.org_deploy_enabled !== true) {
    errors.push('custom steps require org_deploy_enabled: true');
  }

  const interactivity = (settings.interactivity ?? {}) as Json;
  if (interactivity.is_enabled !== true) errors.push('interactivity must be enabled');
  const urls = [
    (settings.event_subscriptions as Json | undefined)?.request_url,
    interactivity.request_url,
    gemini?.url,
  ].filter((u): u is string => typeof u === 'string');
  if (settings.socket_mode_enabled !== true) {
    for (const u of urls) {
      if (!u.startsWith('https://')) errors.push(`request URL must be https: ${u}`);
    }
    if (new Set(urls).size > 1) errors.push('event, interactivity and command URLs differ');
  }
  return errors;
}

/** Events the wiring subscribes to, read from its source (`app.event('…')` + message events). */
export function wiredEventsFromSource(source: string): string[] {
  const events = new Set<string>();
  for (const m of source.matchAll(/app\.event\(\s*'([a-z_.]+)'/g)) events.add(m[1]!);
  // The agent DM, keyword triggers and thread follow-ups all arrive as message events.
  if (/app\.message\(|app\.event\(\s*'message'/.test(source)) {
    for (const e of ['message.channels', 'message.groups', 'message.im']) events.add(e);
  }
  return [...events].sort();
}
