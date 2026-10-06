# Status

What exists, and how far each part has been verified. "Unit-tested" means tested against fakes
(a recording Slack API, a scripted Gemini stream, a fake IdP/STS). **Nothing here has yet run
against live Slack or a live Gemini Enterprise engine.**

| Area | State | Evidence |
|---|---|---|
| Security review findings (H1–H5, M1–M10) | Fixed | regression tests in each package |
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
| Live receipts, findings `data_table`, Lists, canvas sections, Real-time Search | Implemented | unit-tested against a recording Slack API; `plan`/`data_table` acceptance via `chat.postMessage`/`response_url` is unverified live, so every rich card retries with classic blocks on `invalid_blocks` |
| Canvas *reading* | Implemented | `canvases.getContent` (markdown); falls back to file preview |
| `canvas-edit` undo | Not reversible | Slack doesn't expose prior section content; shown as such |
| Licence-aware onboarding (EXPERIENCE §11, ADR-0003 §1): user-store lookup, pre-turn card, 403 re-check, request → admin approve/assign, App Home + diag line, post-link DM | Implemented | unit-tested against a fake user store and recording Slack API; **`userLicenses.list` filter and `batchUpdateUserLicenses` not yet run live** |
| ADR-0003 §2–§5 (assistant pane trust levels, proactive turns, delegation grants, thread → FAQ) | Designed | ADR only |
| Agents (ADR-0002): `@agent` catalog, chat agents and Deep Research via `agentsSpec`, A2A proxy client, paused-agent continuations, connector-auth prompts, `actionDisabled`, `isSessionLess` removed | Implemented | unit-tested against scripted streams; **no live probe yet** (ADR-0002 § Live probes) |

## Security review (2026-10-05)

A `security-reviewer` pass found no criticals; all high findings and most mediums are fixed, each
with a regression test:

| Finding | Fix |
|---|---|
| H1 canvas read/edit by id | canvas must be shared in a conversation the invoker is in; re-checked at approval |
| H2 workflow steps trusted author-chosen `user_id` | Slack-attested `interactivity` input only; fail closed without it |
| H3 Slack Connect coercion only checked the scope | computed over origin, scope, `--to`, share target; re-checked at approval |
| H4 unattended chat answers posted raw | gated like any write (destination policy, provenance, ledger, undo) or sent to the owner as a plan |
| H5 event triggers could run as the owner | reaction/keyword automations are service-only |
| M1/M2 unescaped labels, links, stream output | titles escaped; links show their real URL; canvas mentions handled; streamed tokens sanitized |
| M3 service reads beyond allow-list | executor reads limited to the admitted scope |
| M4 disconnect resurrection, no revocation | no stale fallback; compare-before-write rotation; RFC 7009 revocation on unlink |
| M5 provenance identity drift | plans pin the drafting principal; approval refused if it changed |
| M6 auto-retried writes | writes use a WebClient with retries disabled and 429s rejected |
| M8/M9 binding off / static key in prod | refused in production; Cloud KMS envelope `KeyProvider` |
| M10 auto-apply used origin policy | destination policy + not externally shared |
| L1–L6, L9, L10 | `email_verified`, no provider bodies in Slack, redacted logs, attached-SA check, check-then-take, all prompt delimiters neutralized, real-channel message keys, `team:read` removed, team id pinned |

Accepted / documented: `remind` DMs only people who took part in the conversation (L4); cron uses a
shared secret header (L8; Cloud Scheduler OIDC is a follow-up); Firestore region is an operator
setting (L7). M7 (Firestore prefix query) was a false positive — the upper bound is U+F8FF, now
written as an explicit escape.

## Security review — stage 2 (2026-10-06)

No criticals. All findings fixed with regression tests:

| Finding | Fix |
|---|---|
| H1 search results posted publicly | search is private-only (agent DM), not shareable, refused in Slack Connect |
| H2 writes to search-hit conversations | search turns are read-only; permalink replies/reactions must target conversations named in the request |
| M1 undocumented membership exception | ADR-0001 §6 + CLAUDE.md state the bounded search exception |
| M2 action items skipped re-checks | list conversation and scope re-checked at approval |
| M3 toggle could resurrect an approved plan | toggles take → modify → save (atomic with approval) |
| M4 Slack Connect users passed the guest check | `is_stranger` / other-team users refused |
| M5 notices wiped shared plan cards | notices go only to the clicker; only the invoker's cancel retires a card |
| M6 list landed but reported failed | announcement failure keeps `applied` + undo + note |
| M7 canvas gated on origin policy | service needs `serviceMayRead` on the canvas's own conversations |
| L1–L4 | search authors not "known users"; hits verified public; names/labels neutralized; list share failure and provenance reported honestly |

## Security review — agents (2026-10-06)

No criticals. All findings fixed with regression tests, except M3, which is accepted (ADR-0002):

| Finding | Fix |
|---|---|
| H1 A2A agents' own tools could act, steered by injected Slack content | A2A agents get Slack content only for a scope the invoker named. A required admin attestation (`sideEffects: none\|confirms`, `identity: user-delegated`). Service only for side-effect-free agents |
| H2 Slack Connect / out-of-region egress to A2A agents | refused in externally shared conversations. `hostedIn` must match `GE_LOCATION` at boot |
| M1 "Try again" replayed the request into the task | a fixed continue message is sent instead |
| M2 continuation stored the composed prompt and `response_url` | stores neither |
| M3 agent `kind` not verified | accepted: the engine refuses A2A agents on streamAssist. A verification check is a follow-up |
| M4 A2A identity not declared | the attestation requires `identity: user-delegated` |
| L1–L5 | search gates and delivery-channel membership re-run on resume; card wording; A2A echo filter (role spelling + our `messageId`); stop button cancels continuations; no service offer for agents that bar it |

## Tooling

| Area | State | Evidence |
|---|---|---|
| CI (typecheck, tests, Python parity, lint, manifest check, Cloud Run render, image build + fail-fast boot) | Implemented | `.github/workflows/ci.yml`; the image was built and booted locally |
| Manifest drift check | Implemented | unit-tested; passes on the checked-in manifest |
| Cloud Run deploy (`deploy/`) | Implemented | render tested locally; `deploy.sh` not yet run against a real project |
| Live probe harness (`bun run probe`) | Implemented | unit-tested against a scripted engine; run against the real regional endpoint with a dummy token (reached it, reported 401 with a hint); not yet run with real credentials |

## Security review — ops tooling (2026-10-06)

No criticals. All findings fixed:

| Finding | Fix |
|---|---|
| H1 the cron shared secret was in the scheduler job config, gcloud argv and gcloud logs | Cloud Scheduler uses OIDC. `/cron/tick` verifies a Google-signed RS256 ID token (issuer, audience, expiry, exact invoker SA, verified email). `GE_CRON_INVOKER` is required in production. The shared secret is dev-only |
| M1 Cloud Run / Build / Scheduler region not tied to `GE_LOCATION` | the renderer refuses a `REGION` outside the residency. `global` needs `ALLOW_GLOBAL_REGION=1` |
| M2 some probes created state | Deep Research sessions and A2A tasks run only with `--allow-state` |
| L1 unvalidated YAML substitutions / double expansion | one-pass substitution. Strict shapes for unquoted values. Control characters rejected. Unit tests in `deploy/test_render.py` |
| L2 catalogs follow `latest` | `SOURCES_VERSION` / `AGENTS_VERSION` pins; docs corrected |
| L3 nested `.env*` could reach the image / build bucket | `**/.env*` in `.dockerignore`; `.gcloudignore` added |
| L4 mutable action tags and base image tag | actions pinned to commit SHAs, base image pinned by digest, Dependabot for both |
| L5 A2A card probe bypassed `proxyUrl` | skipped through a proxy, like the other raw probes |
| L6 probe `--as service` didn't verify the attached SA | compares the metadata-server email first |
| L7 manifest scope deny-list | bot scopes are an allow-list. User scopes must be empty |
| L8 fragile secret header in the scheduler job | gone with H1 |
| INFO renderer missed conditional settings | `WIF_*` required for `oidc`, `GE_SERVICE_ACCOUNT` for service modes |

## Security review — stage 3 memory, diagnostics, insights (2026-10-06)

No criticals. Fixed with regression tests:

| Finding | Fix |
|---|---|
| H1 a note could steer everyone's turns, including unattended and write-proposing ones | memory is never used in unattended runs; guests and externals can't change it; attributed and framed as untrusted in the prompt; 90-day expiry; a note stops grounding answers when its author leaves the channel |
| M1 notes behind a write weren't recorded | note count on plan cards and in the ledger / CSV export |
| M2 two different admin checks | one check: admin or owner of *this* team (fails closed when `team_id` is missing) |
| M3 slash commands used a different team key | every entry point keys state by the install team |
| M4 5 notes could ground answers but not be listed | limit 45 = everything on one card |
| M5 `diag` reached Gemini for non-members; any member could spend the service identity | stops after the access line; `diag service` is admin-only; `diag me` forces your identity |
| M6 telemetry kept channel ids and exact times | no conversation ids; day precision |
| L1/L2 unescaped titles in insights/diag | escaped |
| L3 skewed counts | approval clicks aren't requests; connect prompts aren't denials; auto-applied runs count; one 👍/👎 per person per real answer |
| L4/L5 | sharper denial reasons; CSV guard catches leading whitespace and newlines |
| L7/L8 | 20 adds per person per hour; bot/app messages can't be remembered |
| L10 | `GE_FEATURES=-memory` means "defaults minus memory" |

Accepted: L6, the ledger export lists DM/private ids and links for admins (by design: it's the
admin's audit trail). L9, `forget <n>` is positional (the Forget button uses ids).

## Security review — jobs and connector actions (2026-10-06)

Confirmed: no path runs a connector action without the requester's approval. Fixed with
regression tests:

| Finding | Fix |
|---|---|
| F1 card could truncate the arguments that run; invisible Unicode | full arguments always shown (≤ 2000 chars, ≤ 16 levels; refused if the escaped card wouldn't fit); `\uXXXX` for invisible/private-use characters; summary marked "written by Gemini" |
| F2 connector-written tool docs inside `<capabilities>` | moved to a separate `<connector_tool_docs>` data block; admin-set descriptions preferred; "never copy the conversation into arguments" |
| F3 Slack Connect / guests could drive actions | not offered in externally shared conversations or for guests/externals |
| F4 unattended runs could propose actions | never offered unattended |
| F5 "Approve edited" could approve unseen actions; `edited` flag wrong | edit dialog refused for such plans (UI and runtime); `edited` only when text changed |
| F6 5xx after dispatch reported "failed" | 5xx/408/499/timeouts/unreadable replies are *uncertain* ("may have run — check before trying again") |
| F7 thin ledger trail | ledger row written before dispatch; connector, collection, tool, argument hash and a short reference kept |
| F8 401 re-send on `tools/call` | only `tools/list` re-sends |
| F9/F10 lost cancels; team-wide scans; unbounded cache | cancel in its own key; jobs keyed per person; tool cache capped |
| F11/F13 | job titles escaped; DM link only for current members; connector reply cut to a 120-char reference |
| F12 parser edge cases | depth limit in TS and Python (`RecursionError` handled); 3 new parity rows |

## Security review — licence onboarding (2026-10-06)

No High findings: nothing let anyone get a licence assigned without an authorised approver. Fixed
with regression tests:

| Finding | Fix |
|---|---|
| M1 blocked people offered (and allowed) the service path | no service offer when blocked; service turns denied while the cached state is blocked |
| M2 approval could override a later block | fresh lookup at approval; blocked → request closed, nothing assigned; already assigned → no API call |
| M3 assignment rights could sit on the licensed service account | `GE_LICENCE_CONFIG` requires its own `GE_LICENCE_ADMIN_SERVICE_ACCOUNT` ≠ `GE_SERVICE_ACCOUNT`, and a matching project |
| M4 requests channel could be public or Slack Connect (emails shown) | requests are posted only to a private, internal channel; otherwise refused |
| M5 no audit of an admin-plane write | every decision audited (decider, requester, principal, licence config, admin identity); the 30-day export DMs a licence CSV too |
| L1 case / subject handling | subjects compare exactly; assignment goes to the user store's own spelling of the row |
| L2 request bound to email only | the request stores the principal; approval must match it |
| L3 double click → two cards | request saved before the card is posted |
| L4 lock lost on a store error | lock restored unless a final state was saved |
| L5 identity change counted as a decline | new `void` status: no cooldown, not attributed to the approver |
| L6 decision not tied to the card | the click must come from the request's own card (channel + ts) |
| L7 cached membership for approvers | fresh membership check for decisions |
| L8 guests could request | guests and external members are refused |
| L9 unthrottled fresh lookups | at most one lookup per person per 30 s; open/cooldown checks before any lookup |
| L10 proxy path dropped the store | store kept in the proxied path; the proxy must pin project and region (documented) |

## Next live checks

Start with `bun run probe` (SETUP §6): it covers the Gemini Enterprise half of the list below in
one command.

1. Install the manifest in a sandbox workspace; confirm `chat.startStream` plan/task rendering and
   `markdown` blocks.
2. Link a real Entra/Okta account through WIF; run `/gemini whoami` and a grounded `summarize`.
3. Configure the licensed service account; confirm a `service-only` channel answer.
4. Mount both skills; run `draft` and `notes` end to end, then approve, undo, and check the App Home
   ledger.
5. Confirm `plan` and `data_table` blocks render in `chat.postMessage` and `response_url` updates
   (or that the classic fallback fires); create a List on a paid workspace and check the checklist
   fallback on a free one; run `@Gemini ask scope:search("…")` and confirm guests are refused.
6. Cloud Scheduler → `/cron/tick`; reaction and keyword triggers; a Workflow Builder step.
7. Agents (ADR-0002 § Live probes): `@research` plan → Start research under WIF; an A2A agent's
   `INPUT_REQUIRED` round trip; `connectorAuthErrors` with an unauthorized connector;
   `actionDisabled` accepted.
