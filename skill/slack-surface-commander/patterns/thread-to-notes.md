---
title: Thread to notes
kind: pattern
skill: slack-surface-commander
intent: notes
load_when: Turning a thread or channel window into notes with owned action items.
---

# Thread → notes + owned action items

**Shape:** one `reply` (in scope) holding the notes, then one `remind` per action item that has
**both** an owner id in context **and** an explicit due time. Nothing else.

1. Decisions first, one bullet each, past tense.
2. Action items as a markdown checklist: `- [ ] <@U…> task — due <when>`. Owner must be a
   `<@U…>` from `<slack_context>`; if nobody owns it, write `- [ ] _unassigned_ task`.
3. Open questions last (optional).
4. `remind` only for items with a stated date/time; convert to ISO-8601 with the offset of the
   time zone in context. "Soon", "next sprint", "ASAP" are not times — no reminder.

```cmd
reply """*Notes — release sync*
*Decided*
• Ship 2.4 on Tuesday behind the `new_checkout` flag
*Action items*
- [ ] <@U0MAYA> write the rollback runbook — due Mon 10-12 12:00 PT
- [ ] <@U0LI> confirm on-call coverage
- [ ] _unassigned_ update the status page copy
*Open*
• Do we need legal sign-off for the EU rollout?
"""
remind <@U0MAYA> 2026-10-12T12:00:00-07:00 "Rollback runbook for 2.4 (release sync)"
done
```

Avoid: a reminder for `<@U0LI>` (no due time), a reminder for an unassigned item, posting the
notes to another channel, or a canvas the plan didn't ask for.
