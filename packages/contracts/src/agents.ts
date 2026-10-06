import { z } from 'zod';
import { isActuating, type Intent } from './intent.js';
import type { Ground } from './ground.js';

/**
 * Gemini Enterprise agents the `@` picker can address (ADR-0002). Three invocation paths exist,
 * and each has a different shape on the wire:
 *
 * - `assistant`: a Workflow Builder (ex Agent Designer) chat agent or a Google-made agent, called
 *   through `:streamAssist` with `agentsSpec.agentSpecs[{agentId}]`. Engine Model Armor applies.
 * - `deep-research`: the Google Deep Research agent. Same transport, but two phases: the first
 *   turn returns a research plan, and the plan only runs when the invoker starts it.
 * - `a2a`: a full-code (ADK / A2A) agent registered to the app, called through the Gemini
 *   Enterprise A2A proxy (`…/agents/{id}/a2a/v1/message:stream`). It can ask for input or for
 *   authorization mid-task. Engine Model Armor does NOT screen these agents.
 *
 * Skills are not agents: they are mounted by mention on the planner/commander routes and can't be
 * combined with an agent in one turn.
 */
export const AgentKindSchema = z.enum(['assistant', 'deep-research', 'a2a']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentEntrySchema = z.object({
  alias: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/i, 'aliases are letters, digits, . _ -'),
  title: z.string().min(1).max(80),
  kind: AgentKindSchema,
  /** The terminal agent id (numeric for registered agents, a slug such as `deep_research`). */
  agentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'agentId is the last segment of the name'),
  description: z.string().max(200).optional(),
  /** May the service principal call this agent? Default false (fail closed). */
  serviceAllowed: z.boolean().default(false),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

export function agentKindLabel(kind: AgentKind): string {
  return kind === 'a2a' ? 'A2A agent' : kind === 'deep-research' ? 'Deep Research' : 'agent';
}

export type AgentAdmission =
  | { ok: true; agent: AgentEntry | undefined; grounds: Ground[] }
  | {
      ok: false;
      reason: 'multiple' | 'write-verb' | 'service' | 'unattended' | 'search';
      message: string;
    };

/**
 * Pure policy for a turn that names an agent with `@alias`. Agents answer; they never write to
 * Slack — every Slack write still goes through plan → approve → actuate. Returns the remaining
 * (non-agent) grounds.
 */
export function admitAgent(
  input: {
    verb: Intent;
    grounds: Ground[];
    principal: 'user' | 'service';
    unattended: boolean;
    scope: string;
  },
  agents: AgentEntry[],
): AgentAdmission {
  const byAlias = new Map(agents.map((a) => [a.alias.toLowerCase(), a]));
  const named: AgentEntry[] = [];
  const grounds: Ground[] = [];
  for (const g of input.grounds) {
    const agent = g.kind === 'alias' ? byAlias.get(g.alias.toLowerCase()) : undefined;
    if (agent) {
      if (!named.includes(agent)) named.push(agent);
    } else grounds.push(g);
  }
  const agent = named[0];
  if (!agent) return { ok: true, agent: undefined, grounds };
  if (named.length > 1) {
    return {
      ok: false,
      reason: 'multiple',
      message: `One agent per request — pick @${named[0]!.alias} or @${named[1]!.alias}.`,
    };
  }
  if (isActuating(input.verb)) {
    return {
      ok: false,
      reason: 'write-verb',
      message: `@${agent.alias} answers questions; it can't ${input.verb} in Slack. Ask it, then use *Draft follow-up* on the answer.`,
    };
  }
  if (input.principal === 'service' && !agent.serviceAllowed) {
    return {
      ok: false,
      reason: 'service',
      message: `@${agent.alias} isn't available to the Gemini service. Connect your account to use it.`,
    };
  }
  // Deep Research waits for the invoker to start its plan; A2A agents can stop for input or
  // authorization. Nobody is there to answer in an unattended run.
  if (input.unattended && agent.kind !== 'assistant') {
    return {
      ok: false,
      reason: 'unattended',
      message: `@${agent.alias} needs a person to respond, so it can't run in an automation.`,
    };
  }
  // A2A agents run outside engine Model Armor and may be hosted elsewhere: workspace search hits
  // (conversations the invoker hasn't joined) are never forwarded to them.
  if (input.scope === 'search' && agent.kind === 'a2a') {
    return {
      ok: false,
      reason: 'search',
      message: `Workspace search results can't be sent to @${agent.alias}.`,
    };
  }
  return {
    ok: true,
    agent,
    grounds: agent.kind === 'a2a' ? grounds.filter((g) => g.kind === 'this') : grounds,
  };
}
