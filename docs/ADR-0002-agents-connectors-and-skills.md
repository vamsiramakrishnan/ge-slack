# ADR-0002 — Invoking agents, connectors, and skills

**Status:** Accepted (2026-10-06). Extends ADR-0001. Sources: the Discovery Engine discovery
documents (v1alpha rev 20260927), the Gemini Enterprise docs (updated 2026-09-30, release notes to
2026-10-02), and ge-msft's live probes (`ge-msft/docs/api/discoveryengine/*`). Every claim below is
tagged with where it comes from: **[schema]**, **[docs]**, **[ge-msft live]**, or **[unverified]**.

## Context

Until now ge-slack reached Gemini Enterprise one way: `:streamAssist` against the default assistant,
optionally with our two skills (planner, commander) and `@` data stores. Gemini Enterprise also
runs agents — Workflow Builder (formerly Agent Designer) chat agents, Google's Deep Research, and
full-code ADK/A2A agents registered to the app — and connectors with per-user authorization. ChatGPT
and Claude in Slack both route to many tools and agents, so this is where they're catching up with
us. The question is how to reach each kind from Slack without breaking our rules: one principal per
turn, the human as a member, and writes only through plan → approve → actuate.

## What the platform offers

| Kind | How to call it | Identity | Model Armor | Notes |
|---|---|---|---|---|
| Default assistant | `:streamAssist` | caller | engine | what we used before |
| **Skill** (SKILL.md bundle) | `:streamAssist`, `[label](mention://?uri=<id>)` in `query.text` | caller | engine | "cannot invoke both an agent and a skill in the same prompt" **[docs]**. `skillsSpec` isn't public **[schema]** and was ignored **[ge-msft live]**. `agentsSpec` + mention routed in 2026-08 **[ge-msft live]**; an earlier probe saw 500s |
| **Chat agent** (Workflow Builder / Agent Designer, Google-made) | `:streamAssist` + `agentsSpec.agentSpecs[{agentId}]`, terminal id (numeric, or a slug) | caller | engine | **[docs]** "Workflow agents are not supported" on streamAssist |
| **Deep Research** | same, `agentId: "deep_research"` | caller | engine | two turns in one session: a plan (`contentMetadata.contentKind: RESEARCH_PLAN`), then `"Start Research"`, which streams `RESEARCH_QUESTION` progress, a report, and an audio `content.file` **[docs]**. API use is "GA with allowlist" |
| **Full-code agent** (ADK on Agent Engine, A2A) | A2A proxy, **v1 only**: `POST …/assistants/default_assistant/agents/{id}/a2a/v1/message:stream`; body `{message:{role:"ROLE_USER",content:[{text}],messageId,contextId?,taskId?}}` | GE forwards the end-user OAuth token it holds after consent; `X-Serverless-Authorization` for Cloud Run **[docs]** | **not applied** — the agent must call it itself **[docs]** | not callable via streamAssist **[docs]**. Tasks can stop in `TASK_STATE_INPUT_REQUIRED` / `TASK_STATE_AUTH_REQUIRED` **[schema]**; how the proxy surfaces them is **[unverified]** |
| **Connector (search)** | `toolsSpec.vertexAiSearchSpec.dataStoreSpecs[{dataStore}]`, with the project **number** | caller's per-connector OAuth, stored by GE after consent in its web app | engine | unauthorized connectors are skipped, and the answer degrades **with** `connectorAuthErrors[]{dataConnector,errorMessage}` **[schema]**. No public API completes consent for a third-party client **[docs]** |
| **Connector (actions)** | — | — | — | "Mutative actions … are not supported" on streamAssist **[docs]**. `dataConnector:invokeConnectorMcp` (`tools/call`) exists in v1alpha **[schema]** but is undocumented **[unverified]** |
| Web / image / video | `toolsSpec.webGroundingSpec{}` / `imageGenerationSpec{}` / `videoGenerationSpec{}` | caller | engine | web only works if the assistant's web grounding type is set **[schema]** |

**WIF caveats [ge-msft live]:**

- Calls that work under workforce identity: `streamAssist`, `engines.get` (data store ids), `agents.get`, the A2A `card` endpoint, and `:listAvailableAgentViews` (undocumented, POST).
- Calls that return 403: `agents.list`, `dataStores.list`, and `dataConnector.get`.
- The Google docs list one WIF exception: Google Workspace connectors.

## Decision

### 1. One `@` namespace, and agents are just another `@alias`

Admins register agents in an **agent catalog** (`GE_AGENTS_JSON`). Each entry has `alias`, `title`, `kind`, `agentId` and `serviceAllowed`, where `kind` is `assistant`, `deep-research` or `a2a`. Users name an agent the same way they name a source:

```
/gemini ask @research "vector DB pricing in the EU"
/gemini ask @helpdesk @runbooks "VPN keeps dropping"
@Gemini ask @triage is checkout down?
```

**No grammar change** (so the Python skill mirrors are untouched). The runtime splits agent aliases from source aliases (`admitAgent`, pure, in contracts). At boot, aliases must be unique across sources, agents, and the keywords `unit`, `this` and `web`. `/gemini sources` lists agents next to sources.

### 2. Admission (fail closed, `contracts/agents.ts`)

| Rule | Why |
|---|---|
| One agent per request | One principal and one answerer per turn; skills and agents can't mix **[docs]** |
| Chat verbs only (`ask`, `summarize`, `explain`; free text) | Agents answer. Every Slack write still goes through our plan → approve → actuate. To write, use *Draft follow-up* on the answer |
| Service principal only if `serviceAllowed` | Same model as `@` sources |
| No `deep-research`/`a2a` in unattended runs | They pause for a person |
| No workspace search (`scope:search`) results to `a2a` agents | A2A agents may be hosted elsewhere and aren't Model Armor–screened. Search hits include channels the invoker hasn't joined |
| Agents ground only on sources named in the request | The channel's `@unit` is not sent implicitly. `a2a` agents get no data stores (they bring their own tools) |

Admission runs **after** principal resolution and the membership gate, so it can't widen anything.

### 3. Transport (`gemini-client`)

- **`GeminiEnterpriseClient`** routes each turn. `a2a` agents go to **`A2aClient`** (the A2A proxy). Everything else goes to `StreamAssistClient`. `buildStreamAssistRequest` refuses agent + skill, and refuses `a2a` on streamAssist.
- **`actionSpec.actionDisabled: true` on every streamAssist request** (opt out with `engineActions`). Connector write-back is never served on our path, so our gate stays the only write path.
- **`isSessionLess` is gone** from the v1alpha schema. Sessionless turns now omit `session` and drop the returned one. Deep Research turns keep their session.
- **New stream events:**
  - `connector-auth`: unauthorized connectors, with display names from `answer.connectorDisplayNames`.
  - `file`: a generated file such as an audio summary. We point at it and never fetch it.
  - `awaiting`: `research-plan`, `input-required` or `auth-required`, plus a handle (`session` or `contextId`/`taskId`).
  - `RESEARCH_QUESTION` replies become activity, not answer text.
- **A2A is never retried.** A full-code agent's tools may have side effects. Only a 401, which is rejected before the agent runs, is re-sent once with a fresh token. Streamed artifacts are de-duplicated (`append` chunks versus snapshots).
- **Skill routing stays mention + `agentsSpec`**, matching the latest live evidence. `GE_SKILL_AGENTS_SPEC=off` switches to mention-only if a tenant sees 500s.

### 4. Paused agents: one continuation, the invoker only

When an agent pauses, the runtime stores an `AgentContinuation`: the agent, the handle, the pinned principal identity, the original origin and invocation, and the last request text. It lasts one hour. Then a private card is shown:

| Pause | Card | Continue with |
|---|---|---|
| Deep Research plan | **Start research** · **Change the plan** (modal) | `"Start Research"` / `"Revise the research plan: …"` on the same session |
| A2A `INPUT_REQUIRED` | **Reply** (modal) | the reply, on the same `contextId`/`taskId` |
| A2A `AUTH_REQUIRED` | **Authorize** (link to `GE_APP_URL`) · **Try again** | the original text re-sent |

Continuation rules:

- **Invoker only.** The continuation is taken exactly once.
- **Re-admitted.** The principal is re-resolved, the membership gate and agent admission are re-checked, and the turn is refused if the identity differs from the one that paused (as with plan approval).
- **No re-reading of Slack.** The agent's session already holds the context.

The answer renders where the original turn did (agent DM thread, mention thread, or privately), using the click's fresh `response_url`.

### 5. Connector authorization

- When `connectorAuthErrors` comes back, the answer lists the skipped connectors and shows **Authorize sources**, a link to `GE_APP_URL` (Gemini Enterprise › Manage your data).
- Connector names come from the engine. They are cleaned of control characters, bounded, and escaped when rendered.
- For the service principal the message says to ask an admin; there is no link.
- We do not try to complete OAuth ourselves: no public API supports that **[docs]**.

### 6. Attribution

- **Footer:** shows `via <agent>` (`· A2A` for full-code agents) next to the principal.
- **Provenance:** `agentId` records `gemini-enterprise:<engine>/agent:<id>` or `…/a2a:<id>`.
- **A2A warning:** answers from A2A agents carry a warning that engine Model Armor didn't screen them. Our output sanitizer still runs on every answer.

## Consequences

- **Differentiation.** Every agent a tenant builds in Workflow Builder or deploys on Agent Engine becomes usable from Slack with no extra code: under the person's own identity, with the same membership gate, and with a visible "via" and provenance. Neither ChatGPT's nor Claude's Slack apps can call a tenant's Gemini Enterprise agents.
- **Egress is admin-controlled.** Slack content reaches an A2A agent only if an admin registered it. The agent sees what the turn admitted (never search hits), framed as data.
- **Side effects are the agent's.** A full-code agent can act through its own tools under the OAuth grant the person gave it in Gemini Enterprise. ge-slack never gives agents Slack write access. Register only agents whose actions ask for confirmation (A2A `INPUT_REQUIRED`), so the confirmation reaches the person as a **Reply** card.
- **Long-running work.** Deep Research can stream for many minutes inside one request. On Cloud Run, raise the request timeout (up to 60 min). A job runner with push notifications (A2A `pushNotificationConfigs`) is the follow-up.

## Live probes before GA

1. `agentsSpec` with a Workflow Builder chat agent id and with `deep_research` under a **WIF** token; the two-phase flow; where `contentMetadata` actually appears.
2. The A2A proxy under WIF: streaming shape (JSON array vs SSE), how `INPUT_REQUIRED`/`AUTH_REQUIRED` surface, `contextId` format.
3. `actionSpec.actionDisabled` on a non-enterprise edition (ignored vs 400).
4. `connectorAuthErrors` + `connectorDisplayNames` with an unauthorized Jira/Salesforce connector.
5. `:listAvailableAgentViews` (undocumented) as an admin-side catalog helper; `engines.get` for data store discovery.
6. `dataConnector:invokeConnectorMcp` `tools/list`/`tools/call` under WIF — the candidate for connector actions run **after** our approval gate (§ Next).

## Next

- **Connector actions behind our gate:** compile an approved plan step into `invokeConnectorMcp` `tools/call`, for example "create the Jira issue". This depends on probe 6.
- **Catalog discovery:** an admin App Home tab that lists `listAvailableAgentViews` results, so registering an agent alias is one click.
- **Files:** fetch generated files (audio summaries, images) once a download API is confirmed, and post them as Slack files under the same gate.
