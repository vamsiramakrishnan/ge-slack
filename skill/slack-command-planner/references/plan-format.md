---
title: Plan format
kind: reference
skill: slack-command-planner
load_when: An exact keyword, fence, or validation rule for the ```plan block is in question.
---

# The ```plan block

The authoritative parser is `parsePlanBlock` in `packages/contracts/src/plan.ts`;
`scripts/parse_plan.py` mirrors it. Anything the bot rejects becomes a re-prompt, never a guess.

## Fence

- The reply must contain **exactly one** opening line `` ```plan `` (trailing spaces/tabs allowed),
  at the start of the text or of a line.
- The block ends at the first following line that begins with three backticks.
- No fence → `no-fence`; two opening lines → `multiple-fences`; no close → `unclosed-fence`.
  All three fail closed. (Prose outside the fence is tolerated by the parser but forbidden by the
  skill contract.)

## Lines

Each non-blank line inside the fence is `key value`, split at the first space. Keys are
case-insensitive. Blank lines, lines starting with `#`, and bare `plan` / `end` lines are ignored.

| Key | Arity | Value |
|---|---|---|
| `intent` | one (last wins) | `ask` `summarize` `explain` `rewrite` `review` `draft` `notes` — lower-cased |
| `surface` | one | must be `slack` (lower-cased before the check) |
| `scope` | one | `<kind> [ref…]` — first word is the kind (`thread`, `channel`, `message`, `canvas`, `dm`, `search`), the rest is the ref |
| `ground` | many | a supplied source title; one pair of surrounding `"` is stripped |
| `step` | many | one ordered, reviewable intention (free text) |
| `exclude` | many | a hard carve-out (free text) |
| `clarify` | many | a blocking question (free text) |
| `confidence` | one | `high` `medium` `low` |

Any other key → `unknown plan key "<key>"`.

## Validation order

1. `intent` present and valid (Zod: `Required` / `Invalid enum value…`).
2. `surface` equals `slack` (`Invalid literal value, expected "slack"`).
3. `confidence`, when present, is valid.
4. At least one `step` or `clarify` (`a plan needs at least one step or a clarify question`).

A plan with any `clarify` line is returned with `needsClarification: true`: the bot shows the
questions instead of a Run button, and the user's answers produce a new plan.

## What the executor receives

After approval the bot renders `<confirmed_plan>` (`renderConfirmedPlan`): intent, scope, ground,
steps and excludes — never `clarify` or `confidence`. The executor may not widen it.
