# Gemini Enterprise for Slack

**Ask Gemini Enterprise about any conversation you choose, grounded on sources you pick, acting as
you — and see, approve, and undo everything it posts.**

A Slack app that brings Gemini Enterprise into channels, threads, DMs, canvases, schedules, and
Workflow Builder. It is the Slack sibling of [ge-msft](https://github.com/vamsiramakrishnan/ge-msft)
and keeps that project's approach: the same seven verbs, `verb × scope × @ground` invocations, the
plan → approve → actuate → ledger lifecycle, and the planner/commander skill pair. It renders that
approach with Slack's own features.

```
/gemini summarize #eng-incidents --since 7d @runbooks
@Gemini notes this thread
/gemini draft "post-incident follow-up" --to #eng-leads
/gemini automate "weekdays 9:00" summarize #eng --to #eng-digest
```

## What it does

| Verb | What happens in Slack |
|---|---|
| `ask` · `summarize` · `explain` | The answer streams in with Slack's plan/task cards (what was read, what grounded it, which identity asked). Citations appear as numbered chips. 👍/👎 feedback on every answer. |
| `rewrite` · `draft` | Gemini proposes a **plan card**: each change, its exact `cmd` line, and approve, edit, or cancel. Only the person who asked can approve. Approved changes land as replies, posts, canvases, scheduled messages, or bookmarks. |
| `review` | Findings land as threaded replies anchored to the message each one is about. |
| `notes` | Produces a summary, decisions, and a checklist of owned action items. Reminders are scheduled into each owner's DM. |

**Entry points**, all producing the same typed `Invocation`:

- the `/gemini` slash command (bare `/gemini` opens a composer modal)
- `@Gemini` mentions
- the agent **Messages tab**, with suggested prompts
- message shortcuts: *Ask · Summarize thread · Draft a reply · Review · Turn into canvas*
- a global ⚡ shortcut
- reaction triggers
- keyword triggers
- schedules
- Workflow Builder steps: *Ask*, *Summarize conversation*, *Draft a message*

**App Home** shows your identity, your automations (pause, run now, delete), and a **Recent
changes** ledger with Undo. Workspace admins also get per-channel identity policy controls.

## Identity: two principals, always visible

| Principal | How it works | Grounds on |
|---|---|---|
| 🔐 **You** | Connect once. The app signs you in with OIDC + PKCE against your IdP (Entra, Okta, or Google). On each turn it gets a fresh id_token, exchanges it through Workforce Identity Federation, and uses a short-lived Google token held only in memory. Your Gemini Enterprise licence and your access apply. | Everything you can open |
| 🏢 **Gemini service** | A Gemini Enterprise-licensed **service account** with no key file: the bot uses the metadata server or IAM Credentials impersonation. Used for automations, Workflow Builder steps, help-desk channels, and Slack Connect. | Only the sources an admin allow-listed for that channel |

How the principal is chosen and enforced:

- **Exactly one principal per turn.** A pure policy function picks it from the channel policy
  (`user-only` by default, `user-preferred`, or `service-only`), whether you're linked, and
  `--as me|service`.
- **The principal is visible everywhere.** It is shown in every answer footer and stamped into
  every write's `ge_provenance` message metadata.
- **Membership is checked on every read and write.** The person asking must be a member of each
  conversation read or posted to; the bot being in the channel is not enough. This is checked
  again when the plan is approved.

See [ADR-0001](docs/ADR-0001-slack-architecture-and-dual-principal-identity.md).

## Repository layout

```
packages/
  contracts/      Zod contracts: grammar (/ verbs, scope, @grounds, flags, automate), principal policy,
                  actuation kinds + inverses + auto-apply gate, provenance metadata, ```cmd / ```plan parsers
  gemini-client/  Discovery Engine :streamAssist client (regional, residency-pinned), WIF user tokens,
                  keyless service-account tokens (metadata server / impersonation)
  identity/       OIDC+PKCE account linking, AES-GCM token vault, IdentityBroker (one principal per turn)
  runtime/        Surface-agnostic Orchestrator: admit → capture → chat | plan → approve → actuate → ledger
  slack-bridge/   The only code that calls Slack: capture, actuations with metadata + inverses,
                  Block Kit, streaming sink (chat.startStream/appendStream/stopStream + fallbacks)
  automations/    Cron schedules (time-zone aware), reaction/keyword triggers, Workflow Builder steps
  app/            Bolt wiring: slash, mentions, agent DM, shortcuts, modals, App Home, OAuth callback, cron
skill/            slack-command-planner + slack-surface-commander bundles (+ Python parity parsers)
manifests/        slack-app.manifest.json
docs/             EXPERIENCE.md (UX spec), ADR-0001, SETUP.md, STATUS.md, mockups/slack.html
```

## Develop

```bash
bun install
bun run typecheck      # tsc -b across workspaces
bun run test           # vitest
bun run test:skills    # Python parser parity tests
bun run lint           # eslint + prettier
cp .env.example .env   # then fill in; Socket Mode (SLACK_APP_TOKEN) is easiest locally
bun run dev
```

How we compare with Claude Tag, @ChatGPT, Slackbot and Google's own Gemini Enterprise Slack app
is in [docs/COMPETITIVE.md](docs/COMPETITIVE.md). How we use Slack's newest agent platform features
(sessions, stop button, context-aware prompts, plan/task cards, data tables, Lists, Work Objects,
Real-time Search) is in [docs/SLACK-UX-ADVANCED.md](docs/SLACK-UX-ADVANCED.md).

The UX spec is [docs/EXPERIENCE.md](docs/EXPERIENCE.md) and the visual mockup is
[docs/mockups/slack.html](docs/mockups/slack.html). [docs/SETUP.md](docs/SETUP.md) covers
deployment. [docs/STATUS.md](docs/STATUS.md) separates what is verified from what has not yet run
against live Slack or Gemini Enterprise.
