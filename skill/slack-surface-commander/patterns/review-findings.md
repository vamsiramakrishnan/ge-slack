---
title: Review findings
kind: pattern
skill: slack-surface-commander
intent: review
load_when: Reviewing a thread, message, or channel window and reporting issues.
---

# Review → one finding per issue

**Shape:** one `finding <permalink> "…" severity=…` per **distinct** issue, anchored on the message
whose content raises it. No summary reply unless the plan asks for one.

- Anchor = the permalink of the exact message in `<slack_context>`. Never construct a permalink
  from a channel id and a guessed ts.
- Text = the issue and the fix in one or two sentences. Quote at most a short phrase.
- Severity: `high` (wrong, unsafe, or blocks a decision), `medium` (should change), `low` (nit).
- Two messages with the same issue → one finding on the first; mention the other permalink in text.
- Respect `exclude` lines: an excluded topic produces no finding even if it is a real issue.
- No issues found → a single `reply "No issues found in the reviewed messages."`.

```cmd
finding <https://acme.slack.com/archives/C0ENG/p1700000000123456> "The rollout has no rollback step. Add the flag-off procedure before Tuesday." severity=high
finding <https://acme.slack.com/archives/C0ENG/p1700000050000100> "\"p99 < 200ms\" has no measurement window; state it (e.g. 7-day)." severity=medium
done
```
