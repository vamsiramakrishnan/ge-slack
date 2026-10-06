/**
 * `bun run probe [--as user|service] [--only a,b] [--connector <collection-id>]
 *                [--allow-state [--deep-research-run]] [--json]`
 *
 * Without --allow-state nothing persistent is created (no sessions, no agent tasks).
 *
 * Runs the ADR-0002 / STATUS.md live probes against the configured Gemini Enterprise engine.
 * Reads only the GE_* settings (no Slack or IdP config needed). Exit code 1 if any probe fails.
 *
 * Credentials (never printed):
 *   --as user     GE_PROBE_ACCESS_TOKEN, else `gcloud auth print-access-token`. For a workforce
 *                 (WIF) user, log gcloud in with your workforce login config first.
 *   --as service  GE_SERVICE_MODE=metadata (run on the bot's runtime) or impersonate (your gcloud
 *                 identity needs roles/iam.serviceAccountTokenCreator on GE_SERVICE_ACCOUNT).
 * GE_PROBE_USER_PROJECT (or WIF_USER_PROJECT) is sent as x-goog-user-project.
 */
import { execFileSync } from 'node:child_process';
import {
  ImpersonatedTokenSource,
  MetadataServerTokenSource,
  type TokenSource,
} from '@ge-slack/gemini-client';
import { geminiClientConfig, loadGeminiSettings } from '../src/config.js';
import { PROBE_NAMES, formatReport, runProbes, type ProbeName } from '../src/probe.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const settings = loadGeminiSettings();
const as = value('as') ?? 'user';
if (as !== 'user' && as !== 'service') throw new Error('--as expects user or service');

const userProject = process.env.GE_PROBE_USER_PROJECT ?? process.env.WIF_USER_PROJECT;
const fetchImpl: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (userProject) headers.set('x-goog-user-project', userProject);
  return globalThis.fetch(input, { ...init, headers });
};

const gcloudToken: TokenSource = {
  async getAccessToken() {
    const env = process.env.GE_PROBE_ACCESS_TOKEN;
    if (env) return env;
    return execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  },
};

let tokens: TokenSource = gcloudToken;
let identity = 'user:probe';
if (as === 'service') {
  const sa = settings.GE_SERVICE_ACCOUNT;
  if (!sa || settings.GE_SERVICE_MODE === 'none') {
    throw new Error(
      '--as service needs GE_SERVICE_MODE (metadata|impersonate) and GE_SERVICE_ACCOUNT',
    );
  }
  if (settings.GE_SERVICE_MODE === 'metadata') {
    const metadata = new MetadataServerTokenSource();
    // The report names this account, so the attached identity must actually be it.
    const attached = await metadata.email();
    if (attached !== sa) throw new Error(`Attached service account ${attached} is not ${sa}.`);
    tokens = metadata;
  } else {
    tokens = new ImpersonatedTokenSource(gcloudToken, { targetServiceAccount: sa });
  }
  identity = `service:${sa}`;
}

const only = (value('only')?.split(',') ?? [...PROBE_NAMES]) as ProbeName[];
const unknown = only.filter((n) => !PROBE_NAMES.includes(n));
if (unknown.length)
  throw new Error(`unknown probe(s): ${unknown.join(', ')} (have ${PROBE_NAMES.join(', ')})`);

const connector = value('connector');
const results = await runProbes(
  {
    gemini: geminiClientConfig(settings),
    sources: settings.sources,
    agents: settings.agents,
    tokens,
    identity,
    fetchImpl,
    ...(connector ? { connector } : {}),
    allowState: flag('allow-state') || flag('deep-research-run'),
    deepResearchRun: flag('deep-research-run'),
    timeoutMs: flag('deep-research-run') ? 30 * 60_000 : 120_000,
  },
  only,
);
console.log(flag('json') ? JSON.stringify(results, null, 2) : formatReport(results));
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
