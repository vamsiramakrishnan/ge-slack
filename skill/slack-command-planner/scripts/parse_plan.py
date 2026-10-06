#!/usr/bin/env python3
"""
parse_plan.py — dependency-free preflight for the planner's ```plan block.

A Python mirror of packages/contracts/src/plan.ts parsePlanBlock (with the shared extractFence from
cmd.ts). The TypeScript/Zod side is AUTHORITATIVE: the bot re-parses the plan before it renders the
confirm card. Keep the keys, fence rules and validation order in lockstep with plan.ts.

Rules mirrored:
  - exactly one closed ```plan fence (missing / unclosed / duplicate fail closed);
  - flat keyword lines; blank lines, `#` comments and bare `plan` / `end` lines are skipped;
  - keys: intent surface scope ground step exclude clarify confidence (anything else is an error);
  - intent is one of ask summarize explain rewrite review draft notes; surface must be `slack`;
    confidence is high|medium|low;
  - a plan needs at least one `step` or a `clarify` question.

Usage:
  printf '```plan\\nintent notes\\nsurface slack\\nscope thread\\nstep list action items\\n```\\n' \\
    | python3 parse_plan.py

Prints JSON {"ok": true, "plan": {...}, "needsClarification": bool} or {"ok": false, "error": "..."}.
Exit status 0 when ok, 1 otherwise.
"""

from __future__ import annotations

import json
import re
import sys

INTENTS = ("ask", "summarize", "explain", "rewrite", "review", "draft", "notes")
CONFIDENCE = ("high", "medium", "low")
SCALAR_KEYS = ("intent", "surface", "confidence")


def extract_fence(text: str, lang: str = "plan") -> dict:
    """cmd.ts extractFence: exactly one ```<lang> fence; missing, unclosed, duplicate fail closed."""
    opens = list(re.finditer(r"(^|\n)```" + re.escape(lang) + r"[ \t]*\n", text))
    if not opens:
        return {"ok": False, "reason": "no-fence"}
    if len(opens) > 1:
        return {"ok": False, "reason": "multiple-fences"}
    start = opens[0].end()
    close = text.find("\n```", start - 1)
    if close < 0:
        return {"ok": False, "reason": "unclosed-fence"}
    return {"ok": True, "body": text[start:close]}


def _unquote(s: str) -> str:
    s = s.strip()
    m = re.fullmatch(r'"(.*)"', s)
    return m.group(1) if m else s


def _enum_error(values, received) -> str:
    expected = " | ".join(f"'{v}'" for v in values)
    return f"Invalid enum value. Expected {expected}, received '{received}'"


def _validate(draft: dict) -> str | None:
    """Zod CommandPlanSchema, first issue in schema key order (intent, surface, …, confidence)."""
    intent = draft.get("intent")
    if intent is None:
        return "Required"
    if intent not in INTENTS:
        return _enum_error(INTENTS, intent)
    if draft.get("surface") != "slack":
        return 'Invalid literal value, expected "slack"'
    confidence = draft.get("confidence")
    if confidence is not None and confidence not in CONFIDENCE:
        return _enum_error(CONFIDENCE, confidence)
    return None


def parse_plan_block(response: str) -> dict:
    fence = extract_fence(response, "plan")
    if not fence["ok"]:
        return {"ok": False, "error": fence["reason"]}
    draft: dict = {"ground": [], "steps": [], "excludes": [], "clarify": []}
    for raw in fence["body"].split("\n"):
        line = raw.strip()
        if not line or line.startswith("#") or line in ("plan", "end"):
            continue
        sp = line.find(" ")
        key = (line if sp < 0 else line[:sp]).lower()
        value = "" if sp < 0 else line[sp + 1 :].strip()
        if key in SCALAR_KEYS:
            draft[key] = value.lower()
        elif key == "scope":
            parts = re.split(r"\s+", value)
            scope = {"kind": parts[0]}
            if len(parts) > 1:
                scope["ref"] = " ".join(parts[1:])
            draft["scope"] = scope
        elif key == "ground":
            draft["ground"].append(_unquote(value))
        elif key == "step":
            draft["steps"].append(value)
        elif key == "exclude":
            draft["excludes"].append(value)
        elif key == "clarify":
            draft["clarify"].append(value)
        else:
            return {"ok": False, "error": f'unknown plan key "{key}"'}
    problem = _validate(draft)
    if problem:
        return {"ok": False, "error": problem}
    if not draft["steps"] and not draft["clarify"]:
        return {"ok": False, "error": "a plan needs at least one step or a clarify question"}
    return {"ok": True, "plan": draft, "needsClarification": bool(draft["clarify"])}


def render_confirmed_plan(plan: dict) -> str:
    """plan.ts renderConfirmedPlan — the executor's <confirmed_plan> block."""
    lines = [
        "<confirmed_plan>",
        "The user approved this intent only. Do not widen scope or add effects beyond it.",
        f"intent {plan['intent']}",
    ]
    scope = plan.get("scope")
    if scope:
        lines.append(f"scope {scope['kind']}" + (f" {scope['ref']}" if scope.get("ref") else ""))
    lines += [f'ground "{g}"' for g in plan.get("ground", [])]
    lines += [f"step {s}" for s in plan.get("steps", [])]
    lines += [f"exclude {e}" for e in plan.get("excludes", [])]
    lines.append("</confirmed_plan>")
    return "\n".join(lines)


def main() -> int:
    result = parse_plan_block(sys.stdin.read())
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
