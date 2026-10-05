# Setup — Gemini Enterprise for Slack

Five pieces, in order: the Gemini Enterprise app, the identities (user federation + service
account), the skills, the Slack app, and the bot deployment.

## 1. Gemini Enterprise

1. Pick the Gemini Enterprise app (engine) and note `project`, `location`, `engine`. `location`
   **is the residency pin** (`eu`, `us`, or the explicit `global`); the bot refuses to start without it.
2. Create the data stores you want as `@` sources and list them in `GE_SOURCES_FILE`
   (see `sources.example.json`). Mark `serviceAllowed: true` only for shared, non-personal sources.
3. Model Armor, agent routing, and grounding are engine configuration, not bot configuration.

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

```bash
gcloud run deploy ge-slack --source . --region europe-west1 \
  --service-account gemini-slack-runtime@PROJECT.iam.gserviceaccount.com \
  --no-cpu-throttling --min-instances 1 \
  --set-env-vars GE_STORE=firestore,NODE_ENV=production,... \
  --set-secrets SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing:latest,GE_CRON_SECRET=ge-cron:latest,IDP_CLIENT_SECRET=idp-secret:latest
```

- `--no-cpu-throttling`: Gemini turns continue after the 3-second Slack `ack()`.
- Vault keys: production refuses a static `GE_SLACK_VAULT_KEY`. Create a KMS key, grant the runtime
  SA `roles/cloudkms.cryptoKeyDecrypter` on that key only, and set `GE_SLACK_KMS_KEY` +
  `GE_SLACK_WRAPPED_KEYS` (KMS ciphertext of a 32-byte data key; add `k0=…` entries when rotating).
- Firestore: create the database in the same region as `GE_LOCATION`; plans, resume payloads and
  24-hour answers (for *Share*) are stored there.
- Firestore: enable a TTL policy on field `expiresAt` of collection `ge_slack_kv`.
- Cloud Scheduler: `POST ${PUBLIC_BASE_URL}/cron/tick` every minute with header
  `X-GE-Cron-Secret: <GE_CRON_SECRET>`.
- Keep any `GE_PROXY_URL` egress in the same residency region.
