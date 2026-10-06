# Mockups — Gemini Enterprise for Slack

`slack.html` is a single self-contained, static UX mockup (inline CSS, no scripts; Google Fonts only)
that depicts [`../EXPERIENCE.md`](../EXPERIENCE.md). Open it in a browser. It follows the system
light/dark preference and stacks the panels on narrow widths.

The top strip is a **grammar cheat sheet** (verbs, scope tokens, `@` grounds, flags, control verbs).
The bottom strip maps the five ge-msft invariants to the scenes that satisfy them.

| # | Scene | Slack features | Invariant(s) |
|---|---|---|---|
| 1 | `/gemini summarize #eng-incidents --since 7d @unit` → ephemeral streamed answer with plan/task block, numbered citation chips, identity footer, Share / Draft follow-up / Ask a follow-up, 👍/👎 | slash command, `chat.startStream` + `plan_update`/`task_update`, `feedback_buttons` | Grounded or it says so · One identity envelope |
| 2 | `@Gemini draft "post-incident follow-up"` in a thread → plan card (3 numbered effects, reversible/cancellable/external badges, verbatim `cmd` block, Approve all / Edit… / Cancel, only @alex can approve, expiry) | `app_mention`, Block Kit actions, Edit… modal | Provenanced & reversible · One identity envelope |
| 3 | Landed result: threaded reply, canvas unfurl, scheduled message with Cancel, footer "✦ Drafted by Gemini for @alex · 🔐 as you · 2 sources · approved 10:42 [Undo]", `ge_provenance` metadata, undo semantics table | `chat.postMessage` + message metadata, `canvases.create`, `chat.scheduleMessage` | Agent recedes · Provenanced & reversible |
| 4 | Connect flow (ephemeral): Connect with Acme SSO, conditional "Answer with the Gemini service" (shared sources only), pending request resumes; channel policy table user-only / user-preferred / service-only | ephemeral Block Kit, OIDC + PKCE → WIF | One identity envelope |
| 5 | Service-principal answer in a Slack Connect channel: "🏢 as Gemini service · shared sources only" footer and a plain-words coercion notice for `--as me` | Slack Connect, `service-only` policy, single (non-streamed) message | One identity envelope · The unit travels |
| 6 | Composer modal (bare `/gemini` or a shortcut): verb, scope, `@` sources multi-select, people, instruction, Run as, Visibility, live one-line grammar footer | `views.open`, `external_select` | Pre-fill teaches the grammar · The unit travels |
| 7 | Agent Messages tab: suggested prompts, titled session, streamed grounded answer, "Gemini is writing…" status | `agent_view`, `agents.sessions.setStatus`/`rename`, streaming | Grounded or it says so · Agent recedes |
| 8 | App Home: identity card, quick start, Automations (schedule / reaction / keyword, run-as badges, Run now / Pause), Recent changes ledger with Undo / Cancel / "Sent — can't be cancelled", Admin policies + service account status | App Home | Provenanced & reversible · One identity envelope |
| 9 | `/gemini automate "weekdays 9:00" summarize #eng --to #eng-digest` → trigger · action · run-as · destination · next run, actuation-gate notice, Create / Run once now (preview) / Cancel | automations, scheduler | One identity envelope · Actuation gate fails closed |
| 10 | Message shortcut menu (⋯ More actions → Ask Gemini / Summarize thread / Draft a reply / Review / Turn into canvas) and a Workflow Builder step "Gemini: Summarize conversation" with inputs/outputs | message shortcuts, Workflow Builder custom step (`function_executed`) | Pre-fill teaches the grammar · The unit travels |

Sample content is fictional: workspace **Acme**, a recurring cache-tier eviction incident, invoker
Alex Rivera (alex@acme.com), external partner Vendorco.
