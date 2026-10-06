---
title: Thread to notes
kind: pattern
skill: slack-surface-commander
intent: notes
load_when: Turning a thread or channel window into notes with owned action items.
---

# Thread → notes + owned action items

**Shape:** one `reply` (in scope) holding the notes, then one `action` line per action item, then
one `remind` per item that has **both** an owner id in context **and** an explicit due *time*.
Nothing else.

1. Decisions first, one bullet each, past tense.
2. Action items as `action` lines, **not** a checklist in the reply. They land together as one
   Slack List (owner, due date, done); the bridge falls back to a checklist reply where Lists are
   unavailable. The owner must be a `<@U…>` from `<slack_context>`; if nobody owns it, omit the
   owner: `action "update the status page copy"`.
3. `due=YYYY-MM-DD` only for a stated date. "Soon", "next sprint", "ASAP" are not dates.
4. Open questions last (optional), in the reply.
5. `remind` only for items with a stated date *and* time; convert to ISO-8601 with the offset of
   the time zone in context.

```cmd
reply """*Notes — release sync*
*Decided*
• Ship 2.4 on Tuesday behind the `new_checkout` flag
*Open*
• Do we need legal sign-off for the EU rollout?
"""
action <@U0MAYA> "Write the rollback runbook" due=2026-10-12
action <@U0LI> "Confirm on-call coverage"
action "Update the status page copy"
remind <@U0MAYA> 2026-10-12T12:00:00-07:00 "Rollback runbook for 2.4 (release sync)"
done
```

Avoid: repeating the action items as a checklist in the reply, a reminder for `<@U0LI>` (no due
time), a reminder for an unassigned item, posting the notes to another channel, or a canvas the
plan didn't ask for.
