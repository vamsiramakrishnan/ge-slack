# ADR-0001 — Slack architecture and dual-principal identity

**Status:** Accepted (2026-10-05). Inherits ge-msft ADR-0001 (client-direct), ADR-0004 (command
protocol / actuation), ADR-0008 (surface-commander algebra) and ADR-0015 (shared dispatch).

## Context

ge-msft runs inside an Office webview, so the *client* holds the user's short-lived Entra token and
calls Gemini Enterprise directly. Slack has no client-side runtime for apps: every slash command,
mention, shortcut, and button arrives as an HTTPS request (or Socket Mode frame) at **our** server.
So the "client" in ge-msft's client-direct sense is the bot process. Two requirements shape identity:

1. **Execute as the user.** Answers must use the invoker's Gemini Enterprise licence and ACLs — the
   ge-msft "one identity envelope".
2. **Execute as a service account** that has a Gemini Enterprise licence — for unattended
   automations, Workflow Builder steps, shared help channels, and Slack Connect channels whose
   external members can't link an identity.

## Decision

### 1. Topology

```
Slack ──(signed requests / Socket Mode)──► ge-slack bot (Cloud Run, region = GE residency)
                                             │
                     ┌───────────────────────┼───────────────────────────┐
                     ▼                       ▼                           ▼
          IdP (Entra/Okta/Google)    Google STS (WIF) or           Discovery Engine
          OIDC code+PKCE, refresh    IAM Credentials (SA)          :streamAssist (regional)
```

The bot is the only server component. It owns **transport and policy**; Gemini Enterprise owns
grounding, Model Armor, and agent routing exactly as in ge-msft. No gateway sits between the bot and
Discovery Engine; the optional `proxyUrl` stays a transparent egress proxy.

### 2. Two principals, one `Principal` type

```ts
type Principal =
  | { kind: 'user'; teamId; slackUserId; subject; email; provider }
  | { kind: 'service'; serviceAccount; onBehalfOf?: { teamId; slackUserId } };
```

Every turn resolves **exactly one** principal before any read, through a pure policy function
(`resolvePrincipal`) over: the channel identity policy, whether the invoker is linked, the requested
`--as`, and the origin (interactive / automation / workflow). The principal is stamped into the
provenance record and shown in the identity footer of every message.

### 3. User principal — linked federation

- **Linking:** the user clicks *Connect* → OIDC authorization-code flow with **PKCE** and a one-time
  `state` bound to `(team_id, slack_user_id, nonce)` against the tenant IdP that is registered as the
  Workforce Identity Pool provider. `offline_access` is requested only if the user opts into
  *run-as-me automations*; otherwise linking keeps a refresh token valid only for the IdP's default
  session policy.
- **Binding check:** the IdP `email` claim must match the Slack profile email (`users.info`,
  `users:read.email`) unless an admin explicitly disables the check for a domain mapping. A mismatch
  fails closed.
- **At rest:** only the IdP **refresh token** is persisted, sealed with AES-256-GCM under a data key
  (KMS-wrapped in production; `GE_SLACK_VAULT_KEY` in dev), with the `(team, user)` pair as AAD so a
  sealed blob can't be replayed into another user's record.
- **Per turn:** refresh → fresh IdP `id_token` → Google STS token exchange
  (`urn:ietf:params:oauth:grant-type:token-exchange`, audience
  `//iam.googleapis.com/locations/global/workforcePools/<pool>/providers/<provider>`) → short-lived
  Google access token, **cached in memory only** (TTL − 60 s), per user, with ge-msft's
  collapse-concurrent-refresh and invalidate-epoch semantics.
- **Google-identity tenants** (Cloud Identity / Workspace users) may use the `google` provider: the
  Google OAuth access token *is* the user's credential; no STS hop.

### 4. Service principal — keyless licensed service account

- The GE-licensed service account (`GE_SERVICE_ACCOUNT`) is **never** represented by a key file.
  The bot obtains its token either from the **metadata server** (when the bot's runtime service
  account *is* the licensed SA) or by **impersonation** through IAM Credentials
  `generateAccessToken` (the runtime SA holds `roles/iam.serviceAccountTokenCreator` on the licensed
  SA only).
- The service principal may **only** ground on the data stores in the channel's service allow-list,
  and may only read conversations that are in the service channel allow-list. It never reads a
  user's personal connectors and never uses a user's uploaded files.
- `onBehalfOf` records the Slack user who triggered the run; it is attribution, not authority.

### 5. Policy (fail closed)

| Channel policy | Linked user | Not linked | `--as service` | Automation / workflow |
|---|---|---|---|---|
| `user-only` | user | *connect prompt* | denied | owner (run-as-me + offline) or denied |
| `user-preferred` | user | *connect prompt + service offer* | service | service, or owner if run-as-me |
| `service-only` | service | service | service | service |

Slack Connect (externally shared) channels are coerced to `service-only`. Private channels and DMs
default to `user-only` and can't be set to `service-only` without an admin override.

### 6. Membership gate

Reading a conversation requires the **invoker** to be a member (`conversations.members`, cached
briefly), regardless of principal. Bot membership is never sufficient authority. The service
principal additionally requires the channel to be on the service allow-list.

**One bounded exception — workspace search** (`scope:search`, Slack Real-time Search). It follows
Slack's own visibility: a full member may search public channels they haven't joined. It is
allowed only when all of these hold:

- the results are **public channels** only (verified per hit);
- the turn is **private** (agent DM; never a public mention, `--public`, or *Share*);
- the turn is **read-only** (no write verbs, and search hits are never write targets);
- the conversation is **not externally shared**;
- the invoker is **not a guest or external member**;
- service-principal turns keep only hits from allow-listed channels;
- search-hit authors are never treated as conversation participants (no pings, reminders, or
  owners).

## Consequences

- The bot is a credential-holding component (refresh tokens). This is the explicit trade for Slack:
  mitigated by sealing, AAD binding, memory-only Google tokens, no SA keys, and per-user revocation
  (`/gemini disconnect` deletes the sealed record and drops the in-memory token).
- Every surface feature (streaming, plan cards, automations) is identity-agnostic: it receives a
  `TokenSource` from the broker and the `Principal` for display/provenance.
- Admins see and control the service principal's reach per channel in App Home.
