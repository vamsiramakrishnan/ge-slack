import { isUnattended, type Automation, type Invocation, type Origin } from '@ge-slack/contracts';
import {
  ImpersonatedTokenSource,
  MetadataServerTokenSource,
  A2aClient,
  ConnectorMcpClient,
  GeminiEnterpriseClient,
  LicenceDirectory,
  StreamAssistClient,
  type GeminiClientConfig,
} from '@ge-slack/gemini-client';
import {
  AccountLinker,
  IdentityBroker,
  MemoryStore,
  OidcClient,
  StaticKeyProvider,
  CloudKmsKeyProvider,
  TokenVault,
  type KeyValueStore,
  type ServiceIdentity,
} from '@ge-slack/identity';
import {
  JobStore,
  KvTelemetry,
  LicenceService,
  KvWorkspaceConfig,
  Orchestrator,
  RuntimeStores,
} from '@ge-slack/runtime';
import {
  SlackSurface,
  SlackTurnSink,
  defaultResponsePoster,
  type ResponsePoster,
  type SlackApi,
} from '@ge-slack/slack-bridge';
import { AutomationEngine } from '@ge-slack/automations';
import { domainAliases, geminiClientConfig, type AppConfig } from './config.js';
import { FirestoreStore } from './firestore-store.js';
import { GoogleIdTokenVerifier } from './google-id-token.js';

/** Everything the Slack handlers need, composed once from config. */
export interface Container {
  cfg: AppConfig;
  api: SlackApi;
  kv: KeyValueStore;
  surface: SlackSurface;
  broker: IdentityBroker;
  linker: AccountLinker;
  workspace: KvWorkspaceConfig;
  stores: RuntimeStores;
  engine: AutomationEngine;
  orch: Orchestrator;
  postResponse: ResponsePoster;
  telemetry: KvTelemetry;
  jobs: JobStore;
  licences: LicenceService;
  /** Verifies Cloud Scheduler's OIDC token on /cron/tick. */
  cronVerifier: GoogleIdTokenVerifier;
  /** Pick the right rendering for an origin (EXPERIENCE §3 visibility rules). */
  sinkFor(origin: Origin, inv?: Pick<Invocation, 'flags'>): SlackTurnSink;
  unattendedSink(a: Automation, opts: { threadTs?: string }): SlackTurnSink;
}

export interface ContainerDeps {
  api: SlackApi;
  /** Non-retrying client for writes (a retried post can land twice). Defaults to `api`. */
  writeApi?: SlackApi;
  /** Skip the metadata-server SA check (tests only). */
  verifyServiceAccount?: boolean;
  kv?: KeyValueStore;
  fetchImpl?: typeof fetch;
  postResponse?: ResponsePoster;
}

export async function buildContainer(cfg: AppConfig, deps: ContainerDeps): Promise<Container> {
  const fetchImpl = deps.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const kv =
    deps.kv ??
    (cfg.GE_STORE === 'firestore'
      ? await FirestoreStore.create({
          ...(cfg.FIRESTORE_DATABASE ? { databaseId: cfg.FIRESTORE_DATABASE } : {}),
        })
      : new MemoryStore());

  const pairs = (text: string | undefined) =>
    Object.fromEntries(
      (text ?? '')
        .split(',')
        .map((p) => p.trim().split('='))
        .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1])),
    );
  const runtimeIdentity = new MetadataServerTokenSource(fetchImpl);
  const vault = new TokenVault(
    cfg.GE_SLACK_KMS_KEY && cfg.GE_SLACK_WRAPPED_KEYS
      ? new CloudKmsKeyProvider(
          cfg.GE_SLACK_KMS_KEY,
          cfg.GE_SLACK_VAULT_KEY_ID,
          pairs(cfg.GE_SLACK_WRAPPED_KEYS),
          runtimeIdentity,
          fetchImpl,
        )
      : new StaticKeyProvider(cfg.GE_SLACK_VAULT_KEY_ID, {
          ...pairs(cfg.GE_SLACK_VAULT_OLD_KEYS),
          [cfg.GE_SLACK_VAULT_KEY_ID]: cfg.GE_SLACK_VAULT_KEY!,
        }),
  );
  const oidc = new OidcClient(
    {
      kind: cfg.IDP_KIND,
      issuer: cfg.IDP_ISSUER,
      clientId: cfg.IDP_CLIENT_ID,
      ...(cfg.IDP_CLIENT_SECRET ? { clientSecret: cfg.IDP_CLIENT_SECRET } : {}),
      redirectUri: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/callback`,
      displayName: cfg.IDP_DISPLAY_NAME,
    },
    fetchImpl,
  );

  let service: ServiceIdentity | undefined;
  if (cfg.GE_SERVICE_MODE !== 'none' && cfg.GE_SERVICE_ACCOUNT) {
    const metadata = runtimeIdentity;
    if (cfg.GE_SERVICE_MODE === 'metadata' && deps.verifyServiceAccount !== false) {
      // Provenance names this account, so the attached identity must actually be it (L3).
      const attached = await metadata.email();
      if (attached !== cfg.GE_SERVICE_ACCOUNT) {
        throw new Error(
          `Attached service account ${attached} is not GE_SERVICE_ACCOUNT ${cfg.GE_SERVICE_ACCOUNT}.`,
        );
      }
    }
    service = {
      serviceAccount: cfg.GE_SERVICE_ACCOUNT,
      tokens:
        cfg.GE_SERVICE_MODE === 'metadata'
          ? metadata
          : new ImpersonatedTokenSource(
              metadata,
              { targetServiceAccount: cfg.GE_SERVICE_ACCOUNT },
              fetchImpl,
            ),
    };
  }

  const broker = new IdentityBroker({
    store: kv,
    vault,
    oidc,
    ...(cfg.WIF_POOL_ID && cfg.WIF_PROVIDER_ID
      ? {
          wif: {
            poolId: cfg.WIF_POOL_ID,
            providerId: cfg.WIF_PROVIDER_ID,
            ...(cfg.WIF_USER_PROJECT ? { userProject: cfg.WIF_USER_PROJECT } : {}),
          },
        }
      : {}),
    ...(service ? { service } : {}),
    fetchImpl,
  });
  const linker = new AccountLinker(kv, vault, oidc, {
    enforce: cfg.GE_EMAIL_BINDING === 'enforce',
    domainAliases: domainAliases(cfg.GE_EMAIL_DOMAIN_ALIASES),
  });

  const gemini: GeminiClientConfig = geminiClientConfig(cfg);
  const streamClient = new GeminiEnterpriseClient(
    new StreamAssistClient(gemini, fetchImpl),
    new A2aClient(gemini, fetchImpl),
  );

  const surface = new SlackSurface(deps.api, {
    teamId: cfg.SLACK_TEAM_ID,
    ...(deps.writeApi ? { writeApi: deps.writeApi } : {}),
    ...(cfg.SLACK_APP_ID ? { appId: cfg.SLACK_APP_ID } : {}),
    domain: cfg.SLACK_TEAM_DOMAIN,
    fetchImpl,
  });
  const telemetry = new KvTelemetry(kv);
  const jobs = new JobStore(kv);
  const workspace = new KvWorkspaceConfig(kv, cfg.sources, cfg.agents, cfg.connectors);
  const connectorClient = new ConnectorMcpClient(gemini, fetchImpl);
  // Licence lookups and assignment run as an admin-plane identity, never as a person (ADR-0003 §1).
  const licences = new LicenceService(kv, {
    directory: new LicenceDirectory(gemini, cfg.GE_LICENCE_USER_STORE, fetchImpl),
    tokens: cfg.GE_LICENCE_ADMIN_SERVICE_ACCOUNT
      ? new ImpersonatedTokenSource(
          runtimeIdentity,
          { targetServiceAccount: cfg.GE_LICENCE_ADMIN_SERVICE_ACCOUNT },
          fetchImpl,
        )
      : runtimeIdentity,
    principalField: cfg.GE_LICENCE_PRINCIPAL,
    adminIdentity: cfg.GE_LICENCE_ADMIN_SERVICE_ACCOUNT ?? 'runtime service account',
    ...(cfg.GE_LICENCE_CONFIG ? { licenseConfig: cfg.GE_LICENCE_CONFIG } : {}),
    ...(cfg.GE_LICENCE_REQUESTS_CHANNEL
      ? { requestsChannel: cfg.GE_LICENCE_REQUESTS_CHANNEL }
      : {}),
    approvers: (cfg.GE_LICENCE_APPROVERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
  const stores = new RuntimeStores(kv);
  const engine = new AutomationEngine(kv);
  const orch = new Orchestrator({
    surface,
    gemini: { stream: (tokens, turn) => streamClient.stream(tokens, turn) },
    identity: {
      resolve: (i) => broker.resolve(i),
      get serviceConfigured() {
        return broker.serviceConfigured;
      },
      get serviceAccount() {
        return broker.serviceAccount;
      },
      getLinked: (t, u) => broker.getLinked(t, u),
      setAllowUnattended: (t, u, a) => broker.setAllowUnattended(t, u, a),
      // Disconnecting also pauses every automation that runs as this person.
      unlink: async (t, u) => {
        await broker.unlink(t, u);
        await engine.suspendOwner(t, u, 'owner disconnected');
      },
    },
    config: workspace,
    stores,
    automations: engine,
    linker: {
      providerName: cfg.IDP_DISPLAY_NAME,
      start: (p) => linker.start({ ...p }),
    },
    timeZone: cfg.GE_TIME_ZONE,
    ...(cfg.GE_APP_URL ? { appUrl: cfg.GE_APP_URL } : {}),
    features: cfg.features,
    telemetry,
    insights: telemetry,
    jobs,
    licences,
    connectors: {
      listTools: (t, c) => connectorClient.listTools(t, c),
      callTool: (t, c, n, a) => connectorClient.callTool(t, c, n, a),
    },
    version: cfg.GE_VERSION ?? cfg.K_REVISION ?? 'dev',
  });
  const postResponse = deps.postResponse ?? defaultResponsePoster;

  const sinkFor = (origin: Origin, inv?: Pick<Invocation, 'flags'>): SlackTurnSink => {
    const api = deps.api;
    if (isUnattended(origin)) {
      return new SlackTurnSink(
        api,
        {
          mode: 'unattended',
          ownerId: origin.userId,
          destination: inv?.flags.to ?? origin.channelId ?? origin.userId,
          ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
        },
        postResponse,
      );
    }
    const channel = origin.channelId ?? origin.userId;
    if (origin.entry === 'agent-dm') {
      return new SlackTurnSink(
        api,
        {
          mode: 'stream',
          channel,
          threadTs: origin.threadTs ?? origin.messageTs!,
          userId: origin.userId,
          teamId: origin.teamId,
          agentSession: true,
        },
        postResponse,
      );
    }
    const isPublic = origin.entry === 'mention' || inv?.flags.visibility === 'public';
    if (isPublic && origin.channelId) {
      const threadTs = origin.threadTs ?? origin.messageTs;
      return new SlackTurnSink(
        api,
        {
          mode: 'stream',
          channel,
          ...(threadTs ? { threadTs } : {}),
          userId: origin.userId,
          teamId: origin.teamId,
        },
        postResponse,
      );
    }
    return new SlackTurnSink(
      api,
      {
        mode: 'ephemeral',
        channel,
        userId: origin.userId,
        ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
        ...(origin.responseUrl ? { responseUrl: origin.responseUrl } : {}),
        // Button clicks update the card they came from (approval card → live receipt).
        ...(origin.entry === 'button' ? { card: true } : {}),
      },
      postResponse,
    );
  };

  const unattendedSink = (a: Automation, opts: { threadTs?: string }) =>
    new SlackTurnSink(
      deps.api,
      {
        mode: 'unattended',
        ownerId: a.ownerId,
        destination: a.destination ?? a.channelId,
        ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      },
      postResponse,
    );

  return {
    cfg,
    api: deps.api,
    kv,
    surface,
    broker,
    linker,
    workspace,
    stores,
    engine,
    orch,
    postResponse,
    cronVerifier: new GoogleIdTokenVerifier(fetchImpl),
    telemetry,
    jobs,
    licences,
    sinkFor,
    unattendedSink,
  };
}
