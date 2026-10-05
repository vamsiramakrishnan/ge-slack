---
title: Cmd algebra
kind: reference
skill: slack-surface-commander
topics: [statements, strings, entities, reads, effects, errors]
load_when: Exact statement syntax, escaping, or a parse error needs resolving.
---

# The ```cmd algebra

The authoritative parser is `parseProgram` in `packages/contracts/src/cmd.ts`;
`scripts/parse_commands.py` mirrors it statement for statement. A program with any error is not
executed; the bot re-prompts with the error lines.

## Shape

Reads produce context, effects consume it and **terminate** into reviewable changes, controls end
the turn. Nothing executes when parsed: every effect is compiled into an `ActuationRequest`,
previewed on a plan card, and applied only after the invoker approves.

| Class | Verbs | Executes |
|---|---|---|
| read | `read`, `search` | by the host, as the turn's principal, gated by channel membership |
| effect | `reply` `finding` `post` `canvas` `canvas-edit` `schedule` `remind` `bookmark` `react` | only after approval |
| control | `done`, `help` | never touches Slack |

`finding` compiles to the `reply` actuation kind (a threaded reply on the anchor message, carrying
a severity).

## Fence

Exactly one line `` ```cmd `` (at the start of the reply or a line); the body ends at the next line
starting with three backticks. Missing → `no-fence`, two → `multiple-fences`, unterminated →
`unclosed-fence`.

## Tokens

| Token | Form | Notes |
|---|---|---|
| string | `"text"` | one line; `\"` → `"`, `\\` → `\`, `\n` → newline, `\x` → `x`. A raw newline inside is an error — use `"""`. |
| block | `"""…"""` | may span lines; one newline right after the opening `"""` is dropped; no escapes |
| entity | `<…>` | Slack-escaped: `<#C0ENG\|eng>`, `<@U0MAYA>`, `<https://…\|label>` — the part before `\|` is used |
| prop | `key=value` | `since=7d`, `severity=high`, `section=temp:C:abc`; the value may be a word, string or entity |
| word | anything else up to whitespace | verbs, canvas ids, bare channel/user ids, ISO times, `:emoji:` |
| comment | `# …` at the start of a statement | ignored |

Statements end at a newline that is outside a string or block. Verbs are case-insensitive.

## Statements

| Statement | Valid when |
|---|---|
| `read thread` / `read channel [since=24h]` | literal `thread`/`channel`; `since` is `<n>h`, `<n>d`, `<n>w` (capped at 30d by the host) |
| `read <permalink>` | a Slack message permalink (below) |
| `search "query"` | a quoted string |
| `reply "text"` | in the current scope (the thread, or a new thread on the scope message) |
| `reply <permalink> "text"` | threaded under that message |
| `finding <permalink> "text" [severity=…]` | severity ∈ `high` `medium` `low` (case-insensitive) |
| `post <#C…> "text"` | `<#C…>` entity or a bare `C…`/`G…`/`D…` id |
| `canvas "Title" """markdown"""` | both strings present |
| `canvas-edit <id> """markdown""" [section=<id>]` | the id is a bare word (e.g. `F07ABC123`) |
| `schedule <#C…> <time> "text"` | time matches ISO-8601 **with** `Z` or `±hh:mm` |
| `remind <@U…> <time> "text"` | `<@U…>`/`<@W…>` entity or bare id; ISO time with offset |
| `bookmark "Title" <https://…>` | link must start with `https://` |
| `react <permalink> :emoji:` | emoji name `[a-z0-9_+'-]{1,80}`, lower case, between colons |

**Permalink**: host ends with `.slack.com`; path is exactly
`/archives/<C|G|D id>/p<16 digits>`; the message ts is the first 10 digits `.` the last 6
(`p1700000000123456` → `1700000000.123456`). A `?thread_ts=` query is allowed. Lookalike hosts
(`acme.slack.com.evil.io`) and short ts are rejected.

**ISO time**: `YYYY-MM-DDTHH:MM[:SS][.fff](Z|±HH:MM)` — `2026-10-12T09:00:00-07:00`, `2026-10-07T17:00Z`.

## Errors (re-prompt text)

Each bad statement produces `<statement>: <message>`, e.g.

- `unknown verb "repyl" — did you mean "reply"?`
- `schedule: "tomorrow" is not an ISO-8601 time with an offset (e.g. 2026-10-12T09:00:00-07:00)`
- `post <#channel> "text"` (usage reminder when an argument is missing or malformed)
- `finding severity must be high, medium or low`
- `unclosed "string" (use """ for multi-line text)` / `unclosed """ block` (whole program)

Fix the named statement and re-emit the **whole** program. A program with errors never honors
`done`.
