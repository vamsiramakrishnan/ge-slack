import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { GeminiClientConfig } from '@ge-slack/gemini-client';
import {
  AgentEntrySchema,
  GroundSourceSchema,
  type AgentEntry,
  type GroundSource,
} from '@ge-slack/contracts';

/**
 * Deployment configuration, validated at boot. Missing or placeholder values fail fast — the bot
 * never starts half-configured (e.g. with an unpinned Discovery Engine region or no vault key).
 */
const MentionSchema = z
  .string()
  .regex(/^[^|]+\|[^|]+$/, 'expected "label|uri"')
  .transform((s) => {
    const [label, uri] = s.split('|') as [string, string];
    return { label, uri };
  });

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_SIGNING_SECRET: z.string().min(16).optional(),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-').optional(),
  SLACK_APP_ID: z.string().optional(),
  SLACK_TEAM_ID: z.string().regex(/^[TE][A-Z0-9]+$/),
  /** Workspace subdomain (acme → acme.slack.com); used for permalinks instead of team:read. */
  SLACK_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+$/),
  PORT: z.coerce.number().int().default(3000),

  GE_PROJECT: z.string().min(1),
  GE_LOCATION: z.string().min(1, 'GE_LOCATION is required (residency pin)'),
  GE_ENGINE: z.string().min(1),
  GE_COLLECTION: z.string().optional(),
  GE_ASSISTANT: z.string().optional(),
  GE_MODEL_ID: z.string().optional(),
  GE_PROXY_URL: z.string().url().optional(),
  GE_PLANNER_SKILL: z.string().optional(),
  GE_PLANNER_SKILL_MENTION: MentionSchema.optional(),
  GE_COMMANDER_SKILL: z.string().optional(),
  GE_COMMANDER_SKILL_MENTION: MentionSchema.optional(),

  IDP_KIND: z.enum(['oidc', 'google']).default('oidc'),
  IDP_ISSUER: z.string().url(),
  IDP_CLIENT_ID: z.string().min(1),
  IDP_CLIENT_SECRET: z.string().optional(),
  IDP_DISPLAY_NAME: z.string().default('your company SSO'),
  PUBLIC_BASE_URL: z.string().url(),

  WIF_POOL_ID: z.string().optional(),
  WIF_PROVIDER_ID: z.string().optional(),
  WIF_USER_PROJECT: z.string().optional(),

  GE_SERVICE_MODE: z.enum(['none', 'metadata', 'impersonate']).default('none'),
  GE_SERVICE_ACCOUNT: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/)
    .optional(),

  GE_SLACK_VAULT_KEY: z
    .string()
    .min(40, 'GE_SLACK_VAULT_KEY must be 32 random bytes, base64')
    .optional(),
  /** Production: Cloud KMS key that wraps the vault data keys (envelope encryption). */
  GE_SLACK_KMS_KEY: z.string().optional(),
  /** keyId=base64-KMS-ciphertext pairs, comma separated. */
  GE_SLACK_WRAPPED_KEYS: z.string().optional(),
  GE_SLACK_VAULT_KEY_ID: z.string().default('k1'),
  GE_SLACK_VAULT_OLD_KEYS: z.string().optional(),

  GE_STORE: z.enum(['memory', 'firestore']).default('memory'),
  FIRESTORE_DATABASE: z.string().optional(),
  GE_SOURCES_JSON: z.string().optional(),
  GE_SOURCES_FILE: z.string().optional(),
  /** `@agent` catalog (ADR-0002): JSON array of {alias,title,kind,agentId,serviceAllowed}. */
  GE_AGENTS_JSON: z.string().optional(),
  GE_AGENTS_FILE: z.string().optional(),
  /** Gemini Enterprise web app URL, where people authorize connectors and agents. */
  GE_APP_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'GE_APP_URL must be https')
    .optional(),
  /** Mention-only skill routing (omit skills from agentsSpec). */
  GE_SKILL_AGENTS_SPEC: z.enum(['on', 'off']).default('on'),
  GE_EMAIL_BINDING: z.enum(['enforce', 'off']).default('enforce'),
  GE_EMAIL_DOMAIN_ALIASES: z.string().optional(),
  /** Dev / Socket Mode only: shared secret for POST /cron/tick. Production uses OIDC below. */
  GE_CRON_SECRET: z.string().min(24).optional(),
  /** Cloud Scheduler's OIDC identity: /cron/tick accepts only Google ID tokens for this SA. */
  GE_CRON_INVOKER: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/)
    .optional(),
  /** Audience the scheduler mints tokens for; defaults to `${PUBLIC_BASE_URL}/cron/tick`. */
  GE_CRON_AUDIENCE: z.string().url().optional(),
  GE_TIME_ZONE: z.string().default('UTC'),
  NODE_ENV: z.string().default('development'),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  sources: GroundSource[];
  agents: AgentEntry[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (!c.SLACK_APP_TOKEN && !c.SLACK_SIGNING_SECRET) {
    throw new Error('Set SLACK_SIGNING_SECRET (HTTP mode) or SLACK_APP_TOKEN (Socket Mode).');
  }
  if (c.IDP_KIND === 'oidc' && (!c.WIF_POOL_ID || !c.WIF_PROVIDER_ID)) {
    throw new Error(
      'IDP_KIND=oidc requires WIF_POOL_ID and WIF_PROVIDER_ID (Workforce Identity Federation).',
    );
  }
  if (c.GE_SERVICE_MODE !== 'none' && !c.GE_SERVICE_ACCOUNT) {
    throw new Error(
      'GE_SERVICE_MODE requires GE_SERVICE_ACCOUNT (the GE-licensed service account email).',
    );
  }
  if (!c.GE_SLACK_VAULT_KEY && !(c.GE_SLACK_KMS_KEY && c.GE_SLACK_WRAPPED_KEYS)) {
    throw new Error(
      'Set GE_SLACK_KMS_KEY + GE_SLACK_WRAPPED_KEYS (production) or GE_SLACK_VAULT_KEY (dev).',
    );
  }
  if (c.NODE_ENV === 'production') {
    if (c.GE_SLACK_VAULT_KEY) {
      throw new Error(
        'GE_SLACK_VAULT_KEY (static key) is not allowed in production; use Cloud KMS envelope keys.',
      );
    }
    if (c.GE_EMAIL_BINDING !== 'enforce') {
      throw new Error(
        'GE_EMAIL_BINDING must be enforce in production (it is the defence against link injection).',
      );
    }
    if (c.GE_STORE === 'memory')
      throw new Error(
        'GE_STORE=memory is not allowed in production (tokens and plans must persist).',
      );
    if (!c.PUBLIC_BASE_URL.startsWith('https://'))
      throw new Error('PUBLIC_BASE_URL must be https in production.');
    if (!c.SLACK_APP_TOKEN && !c.GE_CRON_INVOKER) {
      throw new Error(
        'GE_CRON_INVOKER is required in production: Cloud Scheduler calls /cron/tick with OIDC, not a shared secret.',
      );
    }
  }
  return { ...c, ...loadCatalogs(c) };
}

/** The `@` catalogs (sources + agents) with their cross-checks; shared by the bot and the probe. */
export function loadCatalogs(c: {
  GE_LOCATION: string;
  GE_SOURCES_JSON?: string | undefined;
  GE_SOURCES_FILE?: string | undefined;
  GE_AGENTS_JSON?: string | undefined;
  GE_AGENTS_FILE?: string | undefined;
}): { sources: GroundSource[]; agents: AgentEntry[] } {
  const raw =
    c.GE_SOURCES_JSON ?? (c.GE_SOURCES_FILE ? readFileSync(c.GE_SOURCES_FILE, 'utf8') : '[]');
  const sources = z.array(GroundSourceSchema).parse(JSON.parse(raw));
  const rawAgents =
    c.GE_AGENTS_JSON ?? (c.GE_AGENTS_FILE ? readFileSync(c.GE_AGENTS_FILE, 'utf8') : '[]');
  const agents = z.array(AgentEntrySchema).parse(JSON.parse(rawAgents));
  // One `@` namespace: an alias must mean exactly one source or one agent.
  const taken = new Set(['unit', 'this', 'web', ...sources.map((s) => s.alias.toLowerCase())]);
  for (const a of agents) {
    // Slack content may only reach agents running inside the residency pin (ADR-0002 §2).
    if (a.attestation && c.GE_LOCATION !== 'global' && a.attestation.hostedIn !== c.GE_LOCATION) {
      throw new Error(
        `Agent @${a.alias} is hosted in ${a.attestation.hostedIn}, outside GE_LOCATION=${c.GE_LOCATION}.`,
      );
    }
    const k = a.alias.toLowerCase();
    if (taken.has(k)) throw new Error(`Agent alias @${a.alias} collides with a source or keyword.`);
    taken.add(k);
  }
  return { sources, agents };
}

/** Only the Gemini Enterprise settings: what `bun run probe` needs (no Slack, IdP or vault). */
const GeminiEnvSchema = EnvSchema.pick({
  GE_PROJECT: true,
  GE_LOCATION: true,
  GE_ENGINE: true,
  GE_COLLECTION: true,
  GE_ASSISTANT: true,
  GE_MODEL_ID: true,
  GE_PROXY_URL: true,
  GE_PLANNER_SKILL: true,
  GE_PLANNER_SKILL_MENTION: true,
  GE_COMMANDER_SKILL: true,
  GE_COMMANDER_SKILL_MENTION: true,
  GE_SKILL_AGENTS_SPEC: true,
  GE_SOURCES_JSON: true,
  GE_SOURCES_FILE: true,
  GE_AGENTS_JSON: true,
  GE_AGENTS_FILE: true,
  GE_SERVICE_MODE: true,
  GE_SERVICE_ACCOUNT: true,
});
export type GeminiSettings = z.infer<typeof GeminiEnvSchema> & {
  sources: GroundSource[];
  agents: AgentEntry[];
};

export function loadGeminiSettings(env: NodeJS.ProcessEnv = process.env): GeminiSettings {
  const parsed = GeminiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return { ...parsed.data, ...loadCatalogs(parsed.data) };
}

/** The `gemini-client` configuration for these settings (bot and probe use the same one). */
export function geminiClientConfig(
  cfg: Omit<GeminiSettings, 'sources' | 'agents'>,
): GeminiClientConfig {
  return {
    assistant: {
      project: cfg.GE_PROJECT,
      location: cfg.GE_LOCATION,
      engine: cfg.GE_ENGINE,
      ...(cfg.GE_COLLECTION ? { collection: cfg.GE_COLLECTION } : {}),
      ...(cfg.GE_ASSISTANT ? { assistant: cfg.GE_ASSISTANT } : {}),
    },
    ...(cfg.GE_MODEL_ID ? { modelId: cfg.GE_MODEL_ID } : {}),
    ...(cfg.GE_PROXY_URL ? { proxyUrl: cfg.GE_PROXY_URL } : {}),
    ...(cfg.GE_PLANNER_SKILL ? { plannerSkills: [cfg.GE_PLANNER_SKILL] } : {}),
    ...(cfg.GE_PLANNER_SKILL_MENTION
      ? { plannerSkillMentions: [cfg.GE_PLANNER_SKILL_MENTION] }
      : {}),
    ...(cfg.GE_COMMANDER_SKILL ? { commandSkills: [cfg.GE_COMMANDER_SKILL] } : {}),
    ...(cfg.GE_COMMANDER_SKILL_MENTION
      ? { commandSkillMentions: [cfg.GE_COMMANDER_SKILL_MENTION] }
      : {}),
    ...(cfg.GE_SKILL_AGENTS_SPEC === 'off' ? { skillAgentsSpec: false } : {}),
  };
}

export function domainAliases(text: string | undefined): Record<string, string> {
  if (!text) return {};
  return Object.fromEntries(
    text
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1])),
  );
}
