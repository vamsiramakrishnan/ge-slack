# Gemini Enterprise skills for Slack

The `/gemini` command surface is carried into Gemini Enterprise as **two skills** in the
[agentskills.io](https://agentskills.io) bundle format (a `SKILL.md` with YAML `name` /
`description` frontmatter, plus `references/`, `patterns/`, `scripts/`). They mirror ge-msft's
`m365-command-planner` / `m365-surface-commander` pair, with Slack's nouns.

```
skill/
├── slack-command-planner/      # PLANNER — free text → exactly one ```plan block (never touches Slack)
│   ├── SKILL.md
│   ├── references/plan-format.md
│   └── scripts/parse_plan.py   # mirror of packages/contracts/src/plan.ts parsePlanBlock
├── slack-surface-commander/    # EXECUTOR — confirmed plan + <slack_context> → exactly one ```cmd fence
│   ├── SKILL.md
│   ├── references/algebra.md  references/slack-semantics.md
│   ├── patterns/thread-to-notes.md  review-findings.md  digest-post.md
│   └── scripts/parse_commands.py   # mirror of packages/contracts/src/cmd.ts parseProgram
├── build_zip.sh                # reproducible bundle zip: ./build_zip.sh <skill-dir>
├── parity-corpus.jsonl         # cmd programs (valid + invalid) with expected kinds / error counts
└── test_parsers.py             # unittest for both parsers, the corpus, and every bundled example
```

## Routing — which skill a turn mounts

The route is derived from the intent (`packages/contracts/src/intent.ts`), never declared
independently, and it is total: a write verb can never reach the plain chat route.

| Route | When | Skill mounted | Model output |
|---|---|---|---|
| **chat** | `ask`, `summarize`, `explain` (`deriveOutput` → `chat`) | none | streamed markdown answer |
| **planner** | a write/annotation verb (`rewrite`, `review`, `draft`, `notes`) typed as free text with constraints, exclusions, a destination, a time, or an audience — or an `inferredVerb` request | `slack-command-planner` | one ```plan block → plan card (Confirm / answer `clarify`) |
| **command** | a write/annotation verb after the plan is confirmed, or a fully specified `verb + scope` request (shortcut, button, simple slash) | `slack-surface-commander` | one ```cmd fence → effects card → approve → actuation gate |

The command route receives `<confirmed_plan>` (from `renderConfirmedPlan`), the per-turn
capability signature (`renderCmdSignature(kinds)` — only the effect kinds the principal, channel
policy and origin allow), and `<slack_context>` with captured messages labelled as data.

## How a skill is mounted per turn

Exactly as ge-msft's `gemini-client` (`stream-assist.ts`): for the planner or command route the
`streamAssist` request carries

1. `agentsSpec.agentSpecs: [{ agentId: "<terminal skill agent id>" }]` — the skill agent created
   from this bundle; and
2. an explicit mention marker prefixed to the query text,
   `[slack-surface-commander](mention://?uri=<url-encoded agent resource>)`, as the model-selection
   hint.

The chat route sends neither. There is no implicit gateway/A2A path and no silent fallback from a
skill route to the chat route: if a skill route has no configured agent, the client must fail the turn with a
configuration error.

## Build and upload

```bash
cd skill
./build_zip.sh slack-command-planner
./build_zip.sh slack-surface-commander
```

`build_zip.sh` checks the frontmatter (`name` must equal the directory) and writes a deterministic
zip (sorted entries, fixed timestamps, normalized permissions). Upload it as a skill agent with the
Discovery Engine AgentService (`agents` create + raw `files:upload`; the server turns `SKILL.md`
into `instruction` and the rest into `subfiles`) — see ge-msft
`docs/api/discoveryengine/skills-and-agents.md` and `skill/create_skill.py`. Store the resulting
agent resource names in the bot's config; never commit tokens.

## Parity with the TypeScript contracts

`packages/contracts/src/{cmd,plan,scope}.ts` are **authoritative**. The Python scripts are
dependency-free preflight mirrors (stdlib only — no `requirements.txt`) with the same verbs, fence
rules, permalink rule, error conditions and messages. When the grammar changes, change the
TypeScript first, then the mirror, then add a row to `parity-corpus.jsonl`.

```bash
# from the repo root
python3 -m unittest discover -s skill -p 'test_*.py'     # == bun run test:skills
printf '```cmd\nread thread\nreply "ok"\ndone\n```\n' | python3 skill/slack-surface-commander/scripts/parse_commands.py
```

Whitespace: both tokenizers treat any non-newline whitespace (including a non-breaking space,
`\f` and `\v`) as a token separator.
