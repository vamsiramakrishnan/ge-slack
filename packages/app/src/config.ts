import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { GroundSourceSchema, type GroundSource } from '@ge-slack/contracts';

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
  SLACK_TEAM_DOMAIN: z.string().optional(),
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

  GE_SLACK_VAULT_KEY: z.string().min(40, 'GE_SLACK_VAULT_KEY must be 32 random bytes, base64'),
  GE_SLACK_VAULT_KEY_ID: z.string().default('k1'),
  GE_SLACK_VAULT_OLD_KEYS: z.string().optional(),

  GE_STORE: z.enum(['memory', 'firestore']).default('memory'),
  FIRESTORE_DATABASE: z.string().optional(),
  GE_SOURCES_JSON: z.string().optional(),
  GE_SOURCES_FILE: z.string().optional(),
  GE_EMAIL_BINDING: z.enum(['enforce', 'off']).default('enforce'),
  GE_EMAIL_DOMAIN_ALIASES: z.string().optional(),
  GE_CRON_SECRET: z.string().min(24).optional(),
  GE_TIME_ZONE: z.string().default('UTC'),
  NODE_ENV: z.string().default('development'),
});

export type AppConfig = z.infer<typeof EnvSchema> & { sources: GroundSource[] };

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
  if (c.NODE_ENV === 'production') {
    if (c.GE_STORE === 'memory')
      throw new Error(
        'GE_STORE=memory is not allowed in production (tokens and plans must persist).',
      );
    if (!c.PUBLIC_BASE_URL.startsWith('https://'))
      throw new Error('PUBLIC_BASE_URL must be https in production.');
  }
  const raw =
    c.GE_SOURCES_JSON ?? (c.GE_SOURCES_FILE ? readFileSync(c.GE_SOURCES_FILE, 'utf8') : '[]');
  const sources = z.array(GroundSourceSchema).parse(JSON.parse(raw));
  return { ...c, sources };
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
