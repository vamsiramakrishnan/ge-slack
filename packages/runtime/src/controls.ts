import {
  agentKindLabel,
  INTENT_DESCRIPTIONS,
  IntentSchema,
  describeTrigger,
  parseCommand,
  type ControlVerb,
  type Origin,
} from '@ge-slack/contracts';
import { runDiagnostics } from './diag.js';
import { forgetNote, rememberNote, showMemory } from './memory.js';
import { showStats } from './insights.js';
import { showJobs } from './jobs.js';
import type { Orchestrator } from './orchestrator.js';
import type { TurnSink } from './ports.js';

export const HELP_TEXT = [
  '*Gemini Enterprise* — `/gemini <verb> [scope] [@sources] [--flags] "instruction"`',
  ...IntentSchema.options.map((v) => `• \`${v}\` — ${INTENT_DESCRIPTIONS[v]}`),
  '*Scope:* `this thread` · `#channel` · a message link · `scope:canvas(<id>)` · `from:@person` · `--since 7d`',
  '*Sources:* `@unit` (this channel’s sources) · `@<source>` · `@this` (conversation only) · `@web`',
  '*Flags:* `--public` · `--to #channel` · `--as me|service` · `--tone formal|friendly|brief` · `--dry-run`',
  '*Automate:* `automate "weekdays 9:00" summarize #eng --to #eng-digest` · `automate on :memo: notes`',
  '*Account:* `connect` · `disconnect` · `whoami` · `sources` · `automations` · `undo <change-id>`',
  '*Memory:* `remember "<note>"` · `memory` · `forget <n>` · *Jobs:* `jobs` · *Check setup:* `diag`',
  'Run `/gemini` with no text to open the composer.',
].join('\n');

export async function handleControl(
  orch: Orchestrator,
  verb: ControlVerb,
  args: string[],
  origin: Origin,
  sink: TurnSink,
): Promise<void> {
  const { identity, config, stores, automations, surface } = orch.deps;
  switch (verb) {
    case 'help':
      await sink.notice('info', HELP_TEXT);
      return;

    case 'remember':
      await rememberNote(orch, origin, args.join(' '), sink);
      return;

    case 'memory':
      await showMemory(orch, origin, sink);
      return;

    case 'forget':
      await forgetNote(orch, origin, { n: Number(args[0]) }, sink);
      return;

    case 'jobs':
      await showJobs(orch, origin, sink);
      return;

    case 'stats':
      await showStats(orch, origin, args, sink);
      return;

    case 'diag': {
      if (!orch.deps.features?.has('diag')) {
        await sink.notice('info', 'Diagnostics are switched off for this workspace.');
        return;
      }
      const as = args[0] === 'service' ? 'service' : args[0] === 'me' ? 'me' : undefined;
      // Running the service identity on demand spends its licence and quota: admins only.
      if (as === 'service' && !(await orch.deps.surface.isWorkspaceAdmin(origin.userId))) {
        await sink.notice('denied', '`/gemini diag service` is for workspace admins.');
        return;
      }
      await sink.notice('info', (await runDiagnostics(orch, origin, as)).join('\n'));
      return;
    }

    case 'connect': {
      if (!orch.deps.linker) {
        await sink.notice('error', 'Account linking is not configured for this workspace.');
        return;
      }
      const url = await orch.deps.linker.start({
        teamId: origin.teamId,
        slackUserId: origin.userId,
      });
      await sink.connect({
        message:
          'Connect Gemini Enterprise so answers use your licence and only sources you can open.',
        connectUrl: url,
        providerName: orch.deps.linker.providerName,
        offerService: false,
        serviceSources: [],
      });
      return;
    }

    case 'disconnect':
      await identity.unlink(origin.teamId, origin.userId);
      await sink.notice(
        'info',
        'Disconnected. Your stored sign-in was deleted; run-as-you automations are paused.',
      );
      return;

    case 'whoami': {
      const linked = await identity.getLinked(origin.teamId, origin.userId);
      const policy = origin.channelId
        ? await config.channelPolicy(origin.teamId, origin.channelId)
        : undefined;
      const lines = [
        linked
          ? `🔐 Connected as *${linked.email}* (${linked.provider}) since ${linked.linkedAt.slice(0, 10)}. Run-as-you automations: *${linked.allowUnattended ? 'allowed' : 'off'}*.`
          : '🔓 Not connected. Run `/gemini connect`.',
        identity.serviceConfigured
          ? `🏢 Gemini service identity: \`${identity.serviceAccount}\``
          : '🏢 No Gemini service identity is configured.',
      ];
      if (policy) lines.push(`This channel's identity policy: *${policy.identity}*.`);
      await sink.notice('info', lines.join('\n'));
      return;
    }

    case 'as': {
      const who = args[0]?.toLowerCase();
      if (who !== 'me' && who !== 'service') {
        await sink.notice('error', 'Usage: `/gemini as me|service <verb> …`');
        return;
      }
      const parsed = parseCommand(args.slice(1).join(' '));
      if (parsed.kind !== 'invoke') {
        await sink.notice('error', 'Usage: `/gemini as me|service <verb> …`');
        return;
      }
      await orch.run(
        { ...parsed.invocation, flags: { ...parsed.invocation.flags, as: who } },
        origin,
        sink,
        parsed.warnings,
      );
      return;
    }

    case 'sources': {
      const catalog = await config.catalog(origin.teamId);
      const channel = origin.channelId;
      if (args[0] === 'add' || args[0] === 'set' || args[0] === 'clear') {
        if (!channel || !(await surface.isMember(channel, origin.userId))) {
          await sink.notice('denied', "You can only change sources for a channel you're in.");
          return;
        }
        const wanted = args.slice(1).map((a) => a.replace(/^@/, '').toLowerCase());
        const known = new Set(catalog.map((c) => c.alias.toLowerCase()));
        const unknown = wanted.filter((w) => !known.has(w));
        if (unknown.length) {
          await sink.notice(
            'error',
            `Unknown source(s): ${unknown.map((u) => `@${u}`).join(', ')}`,
          );
          return;
        }
        const current = (await config.unit(origin.teamId, channel))?.aliases ?? [];
        const aliases =
          args[0] === 'clear'
            ? []
            : args[0] === 'set'
              ? wanted
              : [...new Set([...current, ...wanted])];
        await config.setUnit(origin.teamId, channel, { aliases });
        await sink.notice(
          'info',
          aliases.length
            ? `This channel's @unit is now: ${aliases.map((a) => `@${a}`).join(' ')}`
            : 'Cleared this channel’s @unit.',
        );
        return;
      }
      const unit = channel ? await config.unit(origin.teamId, channel) : undefined;
      const lines = [
        `*@unit here:* ${unit?.aliases.length ? unit.aliases.map((a) => `@${a}`).join(' ') : '_empty_ — `/gemini sources add @name`'}`,
        '*Available sources:*',
        ...catalog.map(
          (c) => `• \`@${c.alias}\` — ${c.title}${c.serviceAllowed ? ' · service-allowed' : ''}`,
        ),
      ];
      const agents = await config.agents(origin.teamId);
      if (agents.length) {
        lines.push(
          '*Agents* (one per request; they answer, and you approve anything posted):',
          ...agents.map(
            (a) =>
              `• \`@${a.alias}\` — ${a.title} · ${agentKindLabel(a.kind)}${a.serviceAllowed ? ' · service-allowed' : ''}`,
          ),
        );
      }
      await sink.notice('info', lines.join('\n'));
      return;
    }

    case 'automations': {
      if (!automations) {
        await sink.notice('info', 'Automations are not enabled.');
        return;
      }
      const mine = await automations.list(origin.teamId, origin.userId);
      await sink.notice(
        'info',
        mine.length
          ? mine
              .map(
                (a) =>
                  `• ${describeTrigger(a.trigger)} → \`${a.invocation.verb}\` in <#${a.channelId}> · ${a.runAs === 'me' ? '🔐 you' : '🏢 service'}${a.enabled ? '' : ' · paused'}`,
              )
              .join('\n')
          : 'No automations yet. Try `/gemini automate "weekdays 9:00" summarize`.',
      );
      return;
    }

    case 'undo': {
      const id = args[0];
      if (!id) {
        await sink.notice('error', 'Usage: `/gemini undo <change-id>` — or use Undo in App Home.');
        return;
      }
      await orch.undo(origin.teamId, id, origin.userId, sink);
      return;
    }
  }
  void stores;
}
