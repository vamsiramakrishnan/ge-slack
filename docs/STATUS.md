# Status

What exists, and how far each part has been verified. "Unit-tested" means tested against fakes
(a recording Slack API, a scripted Gemini stream, a fake IdP/STS). **Nothing here has yet run
against live Slack or a live Gemini Enterprise engine.**

| Area | State | Evidence |
|---|---|---|
| Grammar: `/` verbs, scope, `@` grounds, flags, `automate` | Implemented | unit-tested (`contracts/grammar.test.ts`) |
| Principal policy (user / service, Slack Connect coercion, unattended rules) | Implemented | unit-tested (`contracts/policy.test.ts`, `identity.test.ts`) |
| OIDC + PKCE linking, email binding, sealed refresh tokens, rotation, revocation | Implemented | unit-tested against a fake IdP |
| WIF STS exchange, metadata/impersonated service tokens | Implemented (ported from ge-msft) | unit-tested against fake endpoints |
| `:streamAssist` client (regional, Model Armor block suppression, citations) | Implemented (ported from ge-msft) | unit-tested against a scripted stream |
| Orchestrator: admission, membership gate, chat, planner, executor loop, plan/approve/actuate, undo, share | Implemented | unit-tested (`runtime/orchestrator.test.ts`) |
| Slack capture, actuations + inverses, provenance metadata | Implemented | unit-tested against a recording Slack API |
| Streaming (`chat.startStream` with plan/task chunks) + fallbacks | Implemented | unit-tested; Slack streaming not exercised live |
| Block Kit: answers, plan cards, connect, landed, App Home, composer, policy, edit modal | Implemented | unit-tested for structure; not rendered in Slack |
| Automations: cron (TZ/DST), reaction + keyword triggers, auto-suspend, Workflow Builder steps | Implemented | unit-tested |
| Bolt wiring, OAuth callback, cron endpoint, Firestore store | Implemented | handlers + routes unit-tested; Bolt event delivery and Firestore not exercised |
| Skill bundles (planner + commander) + Python parity parsers | Implemented | Python tests + TS/Python parity corpus |
| Canvas *reading* | Limited | Slack's Web API exposes canvas metadata, not full markdown; capture says when it's truncated |
| `canvas-edit` undo | Not reversible | Slack doesn't expose prior section content; shown as such |

## Next live checks

1. Install the manifest in a sandbox workspace; confirm `chat.startStream` plan/task rendering and
   `markdown` blocks.
2. Link a real Entra/Okta account through WIF; run `/gemini whoami` and a grounded `summarize`.
3. Configure the licensed service account; confirm a `service-only` channel answer.
4. Mount both skills; run `draft` and `notes` end to end, then approve, undo, and check the App Home
   ledger.
5. Cloud Scheduler → `/cron/tick`; reaction and keyword triggers; a Workflow Builder step.
