# COMPETITIVE.md — Gemini Enterprise for Slack vs. Claude, ChatGPT, and Slack's own agents

*Researched 2026-10-05 (agents and connectors 2026-10-06) from vendor docs, Slack's developer changelog, and press. Claims marked*
**(3rd-party)** *come from press or snippets, not first-party docs. Products in this space change
monthly; re-verify before external use.*

## 1. The field in one table

| Product | Who it acts as | Reads | Writes | Review before acting | Automation | Notable limits |
|---|---|---|---|---|---|---|
| **Claude Tag** (Anthropic, public beta since 2026-06, Team/Enterprise) | **Channels:** a shared agent identity (admin-set service accounts; credentials injected at a proxy). **1:1 DMs:** the user's own claude.ai account | Thread, channel history and pins, keyword search of public channels; per-channel and workspace **memory** | Thread replies, files/charts, digests edited in place, claude.ai artifact pages, draft PRs/tickets; cross-channel posts with attribution | **None for channel posts.** Review only when *personal* connectors are used (Allow / Allow with review), plus a sensitive-content screen | Routines: schedules, channel watching, repo/PR triggers; auto-responds without @mention by default | Can't read canvases; no Slack Connect; no retention period or Compliance API coverage during beta; not available with ZDR/CMEK/HIPAA |
| **Claude in Slack (legacy) / Claude Code in Slack** | Per-user OAuth (the user's Claude seat) | Last 20 channel / 50 thread messages | Private draft → user shares; Code: PR under the user's GitHub | Private draft first | — | Being replaced by Claude Tag |
| **ChatGPT app in Slack** (OpenAI, 2025-10) | The user (their ChatGPT account and Slack permissions) | Thread summaries; Slack Real-time Search | Drafts only | n/a | — | 1:1 pane only; doesn't watch channels |
| **@ChatGPT + Team Tasks** (OpenAI, 2026-09-29) | **Admin service account** that "doesn't inherit the creator's permissions"; teammates need no licence **(3rd-party)** | Thread, connected tools | Actions in connected tools, posts, slides | Private **Allow / Deny** card before tool actions | Scheduled and event Team Tasks on the service account; pausing may not stop a run in progress **(3rd-party)** | Channel restrictions don't block DMs; no Slack Connect; shared credit pool |
| **ChatGPT Workspace Agents** (research preview) | Chosen per connection: the end user, or an agent-owned account | Connected tools; per-user memory folder | Files and answers in channel | Not documented | Schedules | Credit-based |
| **Slackbot** (Slack-native agent, GA 2026-01) | The user (Slack permissions) | Everything the user can see; Salesforce; MCP apps | Drafts, canvases, reminders, scheduling | Slack-native | Workflow AI steps | Business+/Enterprise+ (limited on lower tiers); front door to Agentforce and third-party agents |
| **Agentforce in Slack** | Salesforce agent configuration | Salesforce data + Slack | CRM actions | Per agent design | Salesforce flows | Flex-credit pricing |
| **Gemini Enterprise's official Slack app** (Google) | The user, via Google Identity OAuth — **no Workforce Identity Federation** | GE search over connected data stores | **None** ("data store actions are not supported") | n/a | — | Search only; private replies; history doesn't sync to the GE web app |
| **Microsoft Copilot** | — | — | — | — | — | No official Slack app; Copilot reads Slack only through connectors |

**Convergence to note.** In 2026 the leaders moved from per-user assistants to *shared agent
identities* in channels: Claude Tag's channel service accounts and OpenAI's @ChatGPT service
account. That model scales to people without a licence, but it breaks per-user scoping. One
channel member can make the agent reach data that other members can't open, and the audit trail
names a bot rather than a person. The reviews that exist are coarse: Allow/Deny cards, or a
content screen that Anthropic calls "not a guarantee."

## 2. Where we differentiate

### 1. Identity you can see, chosen per channel and never mixed
Competitors hard-wire one model per surface. Claude Tag uses the service identity in channels and
the user in DMs; @ChatGPT uses the service account everywhere. We resolve **exactly one principal
per turn** from the channel's policy:

- `user-only` (the default), `user-preferred`, or `service-only`;
- Slack Connect channels are forced to `service-only`.

The chosen principal appears in every answer footer and in every write's `ge_provenance` metadata.
The membership gate applies to the **human** in both modes, so a service run never lets someone
read a conversation they aren't in. *Pitch: "Shared agent when you want it, your own access when it
matters — and Slack shows you which one answered."*

### 2. The only way to bring Gemini Enterprise to Entra/Okta tenants in Slack
Google's own Slack app requires Google Identity and **does not support WIF**. We federate any
OIDC IdP through Workforce Identity Federation, keep only sealed refresh tokens (Cloud KMS
envelope encryption), and add a **keyless, GE-licensed service account** for shared use. This
makes us the Gemini Enterprise option for Microsoft-identity companies that work in Slack. It is
also the same identity design as ge-msft.

### 3. A plan you can read, not an Allow/Deny prompt
A write never lands without a **plan card**. The card shows:

- each change, its destination, and whether it is reversible;
- the verbatim `cmd` program;
- grounding sources;
- an expiry time;
- that **only the person who asked can approve**.

*Edit…* lets the approver change any text before it lands. Approval is re-checked at click time
(membership, Slack Connect status, and the drafting identity). Claude Tag posts in channels without
review; OpenAI's card asks "Allow?" without showing exactly what will happen.

### 4. Undo and provenance, done honestly
Every write goes into a ledger with a real Slack inverse:

| Write | Undo |
|---|---|
| Message | `chat.delete` |
| Canvas | `canvases.delete` |
| Scheduled message | `chat.deleteScheduledMessage` |
| Bookmark | `bookmarks.remove` |
| Reaction | `reactions.remove` |

Undo is available from the landed message or App Home. Outcomes are reported honestly: a transport
failure is shown as *uncertain*, never as success, and writes are never auto-retried. Canvas
edits are labelled *not reversible* up front. No competitor offers undo.

### 5. Grounded or it says so, on sources you choose
Each channel pins a research unit (`@unit`): Gemini Enterprise data stores and an optional
NotebookLM notebook. Grounding is scoped and visible:

- citations appear as numbered chips;
- the grounding step is shown in the streamed plan block;
- answers with no sources are labelled **ungrounded**.

Competitors ground on ambient search ("whatever the agent can find") or on memory that accumulates
over time.

### 6. One grammar across Microsoft 365 and Slack
The verbs (`ask summarize explain rewrite review draft notes`), the `@` grounds, the planner and
commander skills, and Model Armor/engine configuration are shared with ge-msft (Word, Excel,
PowerPoint, Outlook, OneNote, Teams). A research unit assembled in OneNote can ground the Slack
thread. No competitor spans both suites with one governed engine.

### 7. Governance by default
- The Discovery Engine region is pinned; there is no silent global fallback.
- No transcript store. Answers kept for *Share* expire after 24 hours. This is unlike Claude Tag's
  beta, which has no retention period.
- Unattended runs fail closed:
  - they may auto-apply only a reply in the triggering thread, or a post to their own destination,
    and only under that destination's policy;
  - anything else becomes a plan sent to the owner;
  - reaction and keyword triggers can never run as a person;
  - three failed runs pause the automation.

### 8. Every Gemini Enterprise agent, under your identity, behind the same gate (ADR-0002)
- `@research`, `@helpdesk`, `@triage`: Workflow Builder chat agents, Google's Deep Research and
  full-code ADK/A2A agents are just more `@` aliases.
- They run as the person who asked, after the membership gate. The footer reads `via <agent>`,
  and the agent is stamped into provenance.
- Agents answer. Anything they want posted goes through plan → approve → undo like every other
  write. Connector write-back is switched off on our path (`actionDisabled`).
- Deep Research shows its plan as a card (**Start research** / **Change the plan**) before it
  spends minutes researching. An A2A agent that needs input or authorization stops and asks the
  person who invoked it, privately.
- Skipped connectors are named, with an **Authorize sources** link, rather than silently
  degrading the answer.

ChatGPT's and Claude's Slack apps route only to their own tool ecosystems. Slackbot routes to
Agentforce and MCP apps. None of them can call the agents a company has already built in Gemini
Enterprise.

## 3. Where we are behind, and what to do about it

| Gap | Who has it | Our response |
|---|---|---|
| **Memory** (channel notes) | Claude Tag, Workspace Agents | Opt-in, inspectable **unit notes**, kept as a Gemini Enterprise data store per channel. They are visible and editable from App Home and never created implicitly. Memory becomes grounding the team controls. |
| **Ambient replies** without @mention | Claude Tag | Deliberately off. Provide keyword triggers plus a "watch this channel" automation, gated as above. Add a one-line "Gemini can help" chip on matching threads. |
| **Workspace search** | Slackbot, ChatGPT (Real-time Search) | `scope:search` through the Real-time Search API (`assistant.search.context` with the event's `action_token`) for public channels. Private and DM search uses an optional per-user Slack token. See SLACK-UX-ADVANCED §3. |
| **Rich artifacts** (charts, files) | Claude Tag | Slack-native `data_table`, `data_visualization`, `card`/`carousel` and Lists. See SLACK-UX-ADVANCED §2. |
| **Code tasks / PRs** | Claude Code, Codex, Claude Tag | Route to a tenant's full-code coding agent with `@agent` (ADR-0002) instead of building one. Show Gemini Enterprise code-execution output as task results. |
| **Slackbot as the front door** | Slackbot's MCP client | Expose our verbs as an MCP server so Slackbot can call Gemini Enterprise as the user. See SLACK-UX-ADVANCED §5. |
| **Distribution** | All | Real-time Search and the Slack MCP server need a Marketplace or internal app. Non-Marketplace distributed apps are limited to 1 request/min on conversation history. Ship as an internal (per-tenant) app first; plan Marketplace listing for multi-tenant. |
| **Tool actions** (create the ticket, send the email) | @ChatGPT (Allow/Deny), Claude Tag | Connector actions *after* our approval: compile an approved plan step into `dataConnector:invokeConnectorMcp` `tools/call` (ADR-0002 §Next, live probe pending). The plan card shows the exact call; the ledger records it. |
| **Long-running jobs** | Claude Tag routines, Team Tasks | Deep Research and A2A tasks can run for minutes. Add a job runner with A2A push notifications so the result lands in the thread when it's done, with progress in the plan block. |

### What else it takes to win (ranked)

1. **Agents and connectors** *(shipped in this stage, pending live probes)*. The `@agent`
   catalog, Deep Research two-phase, A2A input/auth pauses, connector-auth prompts. This turns
   the tenant's Gemini Enterprise investment into Slack capability that rivals can't match.
2. **Connector actions behind the gate.** Closes the biggest gap with @ChatGPT: "do it in Jira",
   but as a reviewable plan with a ledger entry, not an Allow/Deny prompt.
3. **Unit notes (memory you can see).** A per-channel data store the team edits in App Home.
   Answers Claude Tag's memory without its opacity.
4. **Background jobs + push.** Long agents finish in the thread; Slack's plan block shows live
   steps; the stop button cancels the job.
5. **Admin console and analytics.**
   - Usage by principal, channel and agent.
   - Feedback (👍/👎 already recorded).
   - Ledger export to BigQuery.
   - Per-agent enablement per channel.

   Enterprise buyers compare governance screens, and ours is the strongest story.
6. **Interop.** An MCP server for our verbs, so Slackbot (and Claude or ChatGPT) can call Gemini
   Enterprise *as the user* through us.
7. **Artifacts.**
   - Post generated files (Deep Research audio, images) under the gate.
   - Render code-execution output as `data_visualization` charts.
8. **Distribution.** Multi-workspace installation store, Enterprise Grid org deploy, and a
   Marketplace listing.

## 4. Positioning

> **Gemini Enterprise for Slack** — *grounded on sources you choose, acting as you or as a shared
> agent you can see, and nothing lands until the person who asked approves it, with undo.*

Lead with four proof points in demos:

1. A Slack Connect channel automatically switches to the shared identity.
2. A plan card shows the exact program, and only the requester can approve it.
3. One click in App Home undoes the canvas Gemini created.
4. `@research` drafts a plan you start with one click, and the company's own A2A agent answers in
   the thread as you, with `via` in the footer.

## Sources

- Anthropic: claude.com/docs/claude-tag/{overview, concepts/agent-identity, concepts/how-it-works, concepts/personal-connectors, concepts/data-lifecycle, admins/restrict-access}; code.claude.com/docs/en/slack; claude.com/docs/connectors/slack
- OpenAI: learn.chatgpt.com/docs/third-party/slack; help.openai.com articles 12462158, 12525822, 20001538, 20001199 (snippets); developers.openai.com/api/docs/guides/agent-builder
- Slack: docs.slack.dev/ai/{developing-agents, agent-sessions, slack-mcp-server}; docs.slack.dev/apis/web-api/real-time-search-api; slack.com/blog/news/slack-is-where-agents-work; salesforce.com/news/press-releases/2026/01/13/slackbot-announcement
- Google: docs.cloud.google.com/gemini/enterprise/docs/configure-slack-app
- Press: techcrunch.com (2026-06-23 Claude Tag), venturebeat.com (Claude Tag; Workspace Agents), engadget.com (ChatGPT for work), beri.net (@ChatGPT service account)
