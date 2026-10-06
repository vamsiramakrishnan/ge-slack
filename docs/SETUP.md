# Setup — Gemini Enterprise for Slack

Five pieces, in order: the Gemini Enterprise app, the identities (user federation + service
account), the skills, the Slack app, and the bot deployment.

## 1. Gemini Enterprise

1. Pick the Gemini Enterprise app (engine) and note `project`, `location`, `engine`. `location`
   **is the residency pin** (`eu`, `us`, or the explicit `global`); the bot refuses to start without it.
2. Create the data stores you want as `@` sources and list them in `GE_SOURCES_FILE`
   (see `sources.example.json`). Mark `serviceAllowed: true` only for shared, non-personal sources.
3. Model Armor, agent routing, and grounding are engine configuration, not bot configuration.
4. **Agents (optional, ADR-0002).** List the agents people may call as `@alias` in
   `GE_AGENTS_FILE` (see `agents.example.json`):
   - `kind` is `assistant` (Workflow Builder / Agent Designer chat agents, Google-made agents),
     `deep-research` (`agentId: deep_research`, allowlisted for API use) or `a2a` (ADK/A2A agents
     registered to the app, called through the A2A proxy).
   - `agentId` is the last segment of the agent's resource name.
   - Aliases must not collide with source aliases.
   - Register `a2a` agents only if their side-effecting tools ask for confirmation (A2A
     `INPUT_REQUIRED`). Engine Model Armor doesn't screen them.
5. **Connector authorization.** Set `GE_APP_URL` to your Gemini Enterprise web app URL. When a
   person hasn't authorized a federated connector, the answer names it and links there (Manage
   your data → Authorize).
6. Deep Research streams for minutes inside one request: set the Cloud Run request timeout to at
   least 30 minutes if you register it.
7. If skill turns return 500s on your tenant, set `GE_SKILL_AGENTS_SPEC=off` (route skills by
   mention only).
8. **Connector actions (optional).** Set `GE_FEATURES=default,connector-actions` and list allowed
   tools in `GE_CONNECTORS_FILE` (see `connectors.example.json`):
   - `collection` is the connector's collection id, as shown in its data store resource name.
   - Only tools named there, *and* offered to the person by the connector, can be proposed.
   - Mark `serviceAllowed` only for side-effect-free tools.
   - Run `bun run probe --only connector-mcp --connector <collection>` first: the API is in the
     schema but not the guides.

## 2. Identities

### User principal (Workforce Identity Federation)

- Register an OIDC app in your IdP (Entra/Okta/Ping) with redirect
  `${PUBLIC_BASE_URL}/oauth/callback`, scopes `openid email profile offline_access`.
- Create a Workforce Identity Pool + OIDC provider trusting that IdP, mapping `google.subject` to
  the IdP subject and carrying `email`. Grant pool principals `roles/discoveryengine.user` on the
  project, and assign Gemini Enterprise licences to the federated users.
- Set `IDP_*`, `WIF_POOL_ID`, `WIF_PROVIDER_ID`. Keep `GE_EMAIL_BINDING=enforce` (IdP email must
  equal the Slack profile email).
- Google-identity tenants: `IDP_KIND=google`, `IDP_ISSUER=https://accounts.google.com`; no WIF needed.

### Service principal (licensed service account, keyless)

- Create a service account (e.g. `gemini-slack@PROJECT.iam.gserviceaccount.com`), assign it a
  Gemini Enterprise licence and `roles/discoveryengine.user`.
- Either run the bot *as* that SA (`GE_SERVICE_MODE=metadata`), or run as a separate runtime SA that
  holds `roles/iam.serviceAccountTokenCreator` **on the licensed SA only** (`GE_SERVICE_MODE=impersonate`).
- Never create a key for it. The service principal only reads channels and sources that a Slack
  admin allow-lists per channel in App Home → Admin.

### Licence lookups and requests (optional, EXPERIENCE §11, ADR-0003 §1)

- Gemini looks up each linked person's licence through an **admin-plane identity**. By default
  that is the runtime service account. To keep it separate, set
  `GE_LICENCE_ADMIN_SERVICE_ACCOUNT=<sa>`; the runtime SA then needs
  `roles/iam.serviceAccountTokenCreator` on that account only.
- Grant that identity a custom role with `discoveryengine.userLicenses.list`. Add
  `discoveryengine.userStores.batchUpdateUserLicenses` only if approvals should assign licences.
  Don't add these grants to the GE-licensed service account.
- `GE_LICENCE_USER_STORE` (default `default_user_store`).
- `GE_LICENCE_PRINCIPAL`: `email` (default) or `subject`. This is the field your user store keys
  people by: a federated user's email when the WIF provider maps it, else the IdP subject. Check
  with `userLicenses.list` once.
- `GE_LICENCE_REQUESTS_CHANNEL=C…`: a private channel for admins. Invite the bot. Without it,
  people are told to ask their admin.
- `GE_LICENCE_APPROVERS=U…,U…`: who can decide, besides workspace admins/owners.
- `GE_LICENCE_CONFIG=projects/<p>/locations/<GE_LOCATION>/licenseConfigs/<id>`: approving then
  assigns that licence. Leave it unset to assign in the console yourself.
- Turn the whole feature off with `GE_FEATURES=-licences`. If the lookup isn't set up, it does
  nothing: every request still goes to Gemini Enterprise, which enforces licences itself.

## 3. Skills

Build and upload `skill/slack-command-planner` and `skill/slack-surface-commander`
(`skill/README.md`). Put their agent resource names and `label|uri` mention markers in
`GE_PLANNER_SKILL[_MENTION]` and `GE_COMMANDER_SKILL[_MENTION]`.

## 4. Slack app

1. api.slack.com → *Create New App* → *From a manifest* → paste `manifests/slack-app.manifest.json`,
   replacing `https://ge-slack.example.com` with your `PUBLIC_BASE_URL`.
2. Install to the workspace; copy the bot token and signing secret. For local development enable
   Socket Mode and create an app-level token (`connections:write`) instead.
3. The manifest enables `agent_view` (Messages tab), the `/gemini` command with `should_escape`,
   shortcuts, App Home, and three remote Workflow Builder functions (these require org-ready
   install, `org_deploy_enabled`). Workflow steps take a Slack-attested `interactivity` input: they
   run only from link/button-started workflows, so the person's channel access can be checked;
   scheduled workflows should use `/gemini automate` instead.
4. Consider enabling token rotation (`token_rotation_enabled`) once your secret store refreshes
   `xoxe` tokens; the default bot token is long-lived.

## 5. Deploy (Cloud Run, same region as `GE_LOCATION`)

`deploy/service.yaml` is the declarative Cloud Run service. `deploy/deploy.sh`:

- renders it from environment variables, and refuses a `REGION` outside the `GE_LOCATION`
  residency and malformed values;
- builds the image with Cloud Build and applies the service;
- allows Slack to reach it;
- (re)creates the Cloud Scheduler tick, authenticated with OIDC.

**One-time setup** (in `PROJECT`, region `REGION` inside the `GE_LOCATION` residency):

1. **Artifact Registry:** create a Docker repository named `ge-slack` in `REGION`.
2. **Runtime service account** (`RUNTIME_SA`). It needs:
   - `roles/datastore.user`;
   - `roles/secretmanager.secretAccessor` on the `ge-slack-*` secrets;
   - `roles/cloudkms.cryptoKeyDecrypter` on the vault key only;
   - with `GE_SERVICE_MODE=impersonate`, `roles/iam.serviceAccountTokenCreator` on the licensed
     `GE_SERVICE_ACCOUNT` only.
3. **Scheduler service account** (`CRON_INVOKER`). `/cron/tick` accepts only Google-signed OIDC
   tokens for this account. There is no shared secret in the job config, in argv, or in gcloud
   logs. The account needs no roles: the app verifies the token itself.
4. **KMS vault key.** Production refuses a static `GE_SLACK_VAULT_KEY`. Create a KMS key and set
   `GE_SLACK_KMS_KEY`. Store `k1=<KMS ciphertext of a 32-byte data key>` in the secret
   `ge-slack-wrapped-keys`; add `k0=…` entries when rotating.
5. **Firestore.** Create the database in the same region as `GE_LOCATION`. Enable a TTL policy on
   field `expiresAt` of collection `ge_slack_kv`. Plans, resume payloads, paused agents and
   24-hour answers (for *Share*) live there.
6. **Secret Manager:** create these secrets.
   - `ge-slack-bot-token`
   - `ge-slack-signing-secret`
   - `ge-slack-wrapped-keys`
   - `ge-slack-idp-client-secret`
   - `ge-slack-sources` (the `@` sources JSON)
   - `ge-slack-agents` (the `@` agents JSON, `[]` if none)

   Set `SOURCES_VERSION` / `AGENTS_VERSION` to pin catalog versions, so a catalog change lands only
   with a redeploy. With the default `latest`, a new version reaches the next instance that starts.
   Restrict `secretmanager.secretVersionAdder` on these two secrets to catalog admins either way.
7. **Public access.** Slack must reach the service, so the script grants `allUsers`
   `roles/run.invoker`. Every request is still authenticated in the app: the Slack signing secret,
   and OIDC on `/cron/tick`. If an org policy forbids `allUsers` bindings, put an external HTTPS
   load balancer in front instead.

**Deploy:**

```bash
export PROJECT=my-proj REGION=europe-west1 RUNTIME_SA=ge-slack-runtime@my-proj.iam.gserviceaccount.com \
  SLACK_TEAM_ID=T0… SLACK_TEAM_DOMAIN=acme PUBLIC_BASE_URL=https://ge-slack.acme.com \
  CRON_INVOKER=ge-slack-scheduler@my-proj.iam.gserviceaccount.com \
  GE_PROJECT=my-proj GE_LOCATION=eu GE_ENGINE=my-engine \
  IDP_KIND=oidc IDP_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 IDP_CLIENT_ID=… \
  WIF_POOL_ID=… WIF_PROVIDER_ID=… GE_SLACK_KMS_KEY=projects/…/cryptoKeys/ge-slack-vault
deploy/deploy.sh                 # or: deploy/deploy.sh --render-only  (just print the YAML path)
```

Then point the manifest's request URLs at `${PUBLIC_BASE_URL}/slack/events`.

**Settings in `deploy/service.yaml`:**

- `cpu-throttling: false`: Gemini turns continue after the 3-second Slack `ack()`.
- One warm instance (`minScale: 1`): Slack's 3-second ack can't absorb a cold start.
- `timeoutSeconds: 3600`: long agent turns (Deep Research) stream inside one request.

Other notes:

- Optional settings (`GE_APP_URL`, skills, `GE_TIME_ZONE`, …) can be added to `deploy/service.yaml`.
  Empty values are dropped at render time.
- Keep any `GE_PROXY_URL` egress in the same residency region.

## 6. Prove it live (`bun run probe`)

Before installing in Slack, run the live probes against the engine. By default nothing persistent
is created, changed or deleted: chat probes are sessionless, the connector probe only lists tools,
and A2A agents only have their card read. `--allow-state` additionally runs the probes that create
state: a Deep Research session in your history, and a task on each A2A agent.

```bash
gcloud auth login            # a workforce (WIF) user: use your workforce login config
GE_PROJECT=… GE_LOCATION=eu GE_ENGINE=… GE_SOURCES_FILE=sources.json GE_AGENTS_FILE=agents.json \
  bun run probe                                  # as you
bun run probe --as service                       # as the licensed service account
bun run probe --only agents --allow-state        # also start a Deep Research plan and ping A2A agents
bun run probe --only agents --deep-research-run  # …and run Deep Research phase 2 (minutes)
bun run probe --only connector-mcp --connector jira-fed_123
```

It prints one PASS / FAIL / skip line per check, with the likely cause of a failure, and exits 1 if
anything fails. Tokens and response bodies are never printed. The checks:

| Probe | What it confirms |
|---|---|
| `stream-assist` | regional `:streamAssist` under this identity, with `actionSpec.actionDisabled` and without `isSessionLess` |
| `grounding` | the `@` sources ground answers. `connectorAuthErrors` parse for unauthorized connectors |
| `skills` | planner and commander routing (`invokedSkills`). If it fails, try `GE_SKILL_AGENTS_SPEC=off` |
| `agents` | each `@` agent: `agentsSpec` chat agents and the A2A agent card. With `--allow-state`, also the Deep Research plan (phase 2 with `--deep-research-run`) and A2A `message:stream` |
| `agent-views` | `:listAvailableAgentViews` (undocumented). Every `@` agent is visible to this identity |
| `engine` | `engines.get`. Every `@` source is attached to the engine |
| `connector-mcp` | `dataConnector:invokeConnectorMcp` `tools/list` (never `tools/call`): the path to connector actions |

Record the results in `docs/STATUS.md`.
