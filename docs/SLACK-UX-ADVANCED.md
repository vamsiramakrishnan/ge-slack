# SLACK-UX-ADVANCED.md — making Gemini feel native by using Slack's newest platform features

Companion to [EXPERIENCE.md](EXPERIENCE.md) (the UX contract) and [COMPETITIVE.md](COMPETITIVE.md).
API names were checked against docs.slack.dev on 2026-10-05; **(unconfirmed)** marks items the
docs don't fully specify.

## 0. Principles

1. **Zero-typing first, grammar second.** Every common job is one tap from where the user already
   is: the channel they're viewing, the message they right-clicked, a chip on an answer. Typing
   `/gemini …` is the power path, and every chip shows its grammar so users learn it.
2. **Show the work as Slack shows work.** Use native plan and task cards, data tables and charts
   instead of walls of text. The thinking is visible, compact and collapsible.
3. **Private until shared.** Default to visible-only-to-you. Making something public is a deliberate,
   attributed act.
4. **One gate, rich preview.** Approval happens once, on a card that shows exactly what will land.
   Execution then visibly ticks through each change.
5. **Never strand the user.** Every terminal state (blocked, denied, expired, uncertain) gives one
   next action.

## 1. P0 — align with the agent platform (implemented in this change)

| Capability | API | What users get |
|---|---|---|
| **Stop button** | Subscribe to `agent_session_stopped`; abort the Gemini stream and `chat.stopStream` | Stopping a long answer cancels the work as well as the UI |
| **Provenance on streamed answers** | `chat.stopStream` `metadata: {event_type: "ge_provenance", …}` and `session_status: "active"` | Streamed answers carry the same provenance as writes; the session leaves "Working…" correctly |
| **Knows where you are** | `app_context_changed` → `event.context.entities[]`; `message.im` carries `app_context` | In the agent DM, "summarize this" means the channel you're viewing. The answer says which channel it read. |
| **Context-aware suggested prompts** | `assistant.threads.setSuggestedPrompts` (≤ 4, **no `thread_ts`** for agent apps; must not coexist with manifest static prompts) | Prompts follow your context: in #eng-incidents you see *Catch me up on #eng-incidents* and *Draft today's incident update* |
| **Titled sessions** | `agents.sessions.setStatus` with `title`, and `agents.sessions.rename` | The sessions sidebar reads "Summarize #eng-incidents · 7d", not "New chat" |

## 2. P1 — render work with Slack's native materials

### Answers
- **Grounding as cards.** The `task_update` for the grounding step carries `sources: [{type:"url",
  url, text}]`, so citations attach to the step that used them.
- **Collapsible "How I got this".** A `container` block (`is_collapsible`, `default_collapsed`)
  holds the plan, the identity, and the exact grounding scope. Answers stay short; detail is one
  tap away.
- **Source cards.** For research answers, use a `carousel` of `card`s (title, snippet, *Open* /
  *Ask about this*) instead of plain link chips.
- **Numbers as charts.** Show channel activity, incident counts, or a metric explained by
  `explain` with `data_visualization` (bar, line, area, or pie; at most 2 per message). Show
  tabular answers with `table`, or `data_table` when sorting and pagination help.
- **Delete my answer.** Add a `context_actions` `icon_button` (`icon: "trash"`,
  `visible_to_user_ids: [invoker]`) next to the feedback buttons. It undoes a public answer.

### Plans and execution
- **Plan card as a native `plan` block.** Each effect is a task (`pending`). After approval, update
  the same message so tasks move `in_progress` → `complete`/`error`, with `output` linking to the
  landed object. The approval card becomes the receipt, so there's no second message.
- **Review findings as a `data_table`.** Columns: anchor (permalink), severity, finding, and an
  `action_cell` (*Post* / *Skip*). Users approve findings individually instead of all at once.
- **Modal alerts.** Use `alert` blocks (modals only) in *Edit…* and the composer to show identity
  coercion ("Slack Connect channel → Gemini service") before submission.

### Durable artifacts
- **Action items as a Slack List.** `notes` writes owners and due dates into a List with
  `slackLists.create` / `slackLists.items.create`. Undo is `items.delete`. Lists require paid
  plans; fall back to a checklist message. This replaces text checklists with a trackable artifact.
- **Precise canvas edits.** Find the target section with `canvases.sections.lookup`
  (`criteria.contains_text`, `section_types`), then make a one-operation `canvases.edit` on that
  `section_id`. Read full canvas content with `canvases.getContent` **(unconfirmed)**; today we only
  read metadata and preview.
- **Work Objects for plans and changes.** Post plans and ledger entries as
  `slack#/entities/task` Work Objects (`chat.postMessage` with `metadata.entities`). The flexpane
  (`entity_details_requested` → `entity.presentDetails`) shows status, principal and sources, with
  primary actions *Approve* / *Undo*. Work Objects also make Gemini source links unfurl into rich,
  permission-aware previews (`link_shared` → `chat.unfurl` with entity metadata, using
  `user_auth_required` when the viewer isn't connected).

## 3. P1 — search and context reach

- **Workspace search as the user.** For `scope:search("…")`, call `assistant.search.context` with
  the `action_token` from the triggering event (bot token, `search:read.public`). For private, DM
  and group-DM results, ask the user once to grant a **user token** (`search:read.private/im/mpim`)
  through optional scopes (`bot_optional`/`user_optional`). This is a third, Slack-side identity
  and is shown in the identity footer.
- **Respect the data rules.** Real-time Search results must not be stored, so they go straight into
  the turn's context and are never persisted. This matches our no-transcript design.
- **Rate-limit realism.** Non-Marketplace distributed apps get 1 request/min, 15 objects, on
  `conversations.history`/`replies`. Ship as an **internal app** per tenant, which keeps normal
  limits. Use Real-time Search instead of history paging for wide scopes.

## 4. P1 — entry points that feel built in

| Entry | Feature | Detail |
|---|---|---|
| Agent DM | `agent_view` Messages tab | Context-aware prompts (§1). The first message in a session sets its title. |
| Channel | `app_mention` + streaming with `recipient_user_id`/`recipient_team_id` | Public slash commands with `--public` stream into a thread anchored on a short root message (streaming needs a `thread_ts` outside session channels) |
| Message | Message shortcuts → composer pre-filled with the grammar | Unchanged; add *Explain this* and *Extract action items* |
| Answer | Chips: *Share*, *Draft follow-up*, related questions | Chips run in place; *Draft follow-up* opens the composer |
| Workflow | Remote custom steps (org-ready) + `workflow_button` on answers | "Start the incident workflow" directly from a Gemini answer |
| Slackbot | **Slackbot MCP client** (`mcp:connect`, manifest `mcp_server`) | Expose `ask`/`summarize`/`draft` as MCP tools so Slackbot can call Gemini Enterprise *as the user* (Slack-identity auth mapped to our linked identity). This puts Gemini Enterprise behind Slackbot as well. |

## 5. P2 — multi-agent etiquette and admin experience

- **Sharing threads with other agents.** Claude Tag, @ChatGPT and Slackbot may be in the same
  thread. Gemini replies only when mentioned or triggered. Messages from other bots
  (`is_author_bot`) are context, never instructions. The identity footer keeps attribution clear.
- **App Home as a control room.** Show running work, plans awaiting approval, and blocked
  automations, with pause, resume, stop and retry controls. Pins and archive follow the
  sessions sidebar.
- **Admin experience.** Org-ready install (`org_deploy_enabled`; also required for custom steps),
  optional scopes so Lists/Canvas/Search can be granted later, token rotation (`xoxe`, 12h), and
  a channel-policy modal that previews what the service identity could read.
- **Audit stream.** Subscribe to our own `ge_provenance` metadata through
  `metadata_subscriptions`, so a SIEM forwarder (or another app) receives every landed change
  without a separate log pipeline.

## 5b. Sequencing

| Release | Scope |
|---|---|
| **Now** (this change) | §1: stop button, provenance on streams, context-aware DM, dynamic prompts, titled sessions, anchored public streams |
| **Next** | Plan → live execution receipt; findings `data_table`; Lists for action items; `canvases.sections.lookup`; Real-time Search for `scope:search` |
| **Then** | Work Objects for plans and changes; source carousels and charts; Slackbot MCP server; metadata audit subscription |
| **Later** | Opt-in unit notes (memory); per-user Slack token for private search; Marketplace listing |
