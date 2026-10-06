#!/usr/bin/env python3
"""
parse_commands.py — dependency-free preflight for the Slack ```cmd algebra.

A faithful Python mirror of packages/contracts/src/cmd.ts (extractFence, splitStatements,
parseStatement, parseProgram) and the permalink rule in packages/contracts/src/scope.ts
(parsePermalink). The TypeScript side is AUTHORITATIVE: the bot re-parses every program, then
compiles, previews and gates each effect behind a human approval. This script only lets the skill
(or a test) catch syntax errors before a round trip.

Keep in lockstep with cmd.ts: same verbs, same error conditions, same messages.

Usage:
  printf '```cmd\\nread thread\\nreply "Thanks"\\ndone\\n```\\n' | python3 parse_commands.py
  python3 parse_commands.py < model-reply.txt

Prints JSON: {"ok", "effects": [...], "reads": [...], "errors": [...], "done", "help"?,
"fenceError"?}. Exit status 0 when ok, 1 otherwise.
"""

from __future__ import annotations

import json
import re
import sys
from urllib.parse import urlsplit

CMD_READ_VERBS = ("read", "search")
CMD_EFFECT_VERBS = (
    "reply",
    "finding",
    "post",
    "canvas",
    "canvas-edit",
    "schedule",
    "remind",
    "bookmark",
    "react",
    "action",
    "act",
)
CMD_CONTROL_VERBS = ("done", "help")
CMD_VERBS = CMD_READ_VERBS + CMD_EFFECT_VERBS + CMD_CONTROL_VERBS

# Which actuation kind each effect verb compiles to (cmd.ts EFFECT_VERB_TO_KIND).
EFFECT_VERB_TO_KIND = {
    "reply": "reply",
    "finding": "reply",
    "post": "post",
    "canvas": "canvas",
    "canvas-edit": "canvas-edit",
    "schedule": "schedule",
    "remind": "remind",
    "bookmark": "bookmark",
    "react": "react",
    "action": "action-items",
    "act": "connector-action",
}

# cmd.ts: act <connector>.<tool> "summary" """{json arguments}"""
_ACT_TARGET = re.compile(r"^@?([a-z0-9][a-z0-9_-]{0,62})\.([A-Za-z0-9_-]{1,64})$")
MAX_ACT_ARGS_CHARS = 8000


def _reject_constant(name: str):
    # JSON.parse rejects NaN / Infinity; json.loads accepts them — keep the mirror strict.
    raise ValueError(name)

_DUE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

# JS `\d` is ASCII-only; spell digits out so Python does not accept other Unicode digits.
ISO = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
)
_PERMALINK_PATH = re.compile(r"^/archives/([CGD][A-Z0-9]+)/p([0-9]{10})([0-9]{6})$")
_THREAD_TS = re.compile(r"^[0-9]{6,}\.[0-9]{1,8}$")
_CHANNEL_ENTITY = re.compile(r"^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$")
_CHANNEL_BARE = re.compile(r"^[CGD][A-Z0-9]{2,}$")
_USER_ENTITY = re.compile(r"^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$")
_USER_BARE = re.compile(r"^[UW][A-Z0-9]{2,}$")
_EMOJI = re.compile(r"^:([a-z0-9_+'-]{1,80}):$")
_KEY = re.compile(r"([a-z][a-z0-9_-]*)=", re.IGNORECASE)
_WS = re.compile(r"\s")


# --------------------------------------------------------------------------------------------
# Fence


def extract_fence(text: str, lang: str = "cmd") -> dict:
    """Exactly one ```<lang> fence. Missing, unclosed, or duplicate fences fail closed."""
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


# --------------------------------------------------------------------------------------------
# Tokenizer


def _tok(kind: str, text: str, key: str | None) -> dict:
    t = {"kind": kind, "text": text}
    if key:
        t["key"] = key
    return t


def split_statements(body: str):
    """Statements are newline-separated outside of quotes. Returns a list of
    {"line", "toks"} or {"error": msg}. Supports "…" with \\" \\\\ \\n escapes, \"\"\"…\"\"\" blocks,
    <…> Slack entities and key=value props."""
    out: list[dict] = []
    toks: list[dict] = []
    line_start = 0
    i = 0
    n = len(body)

    def flush(end: int) -> None:
        nonlocal toks
        line = body[line_start:end].strip()
        if toks and not line.startswith("#"):
            out.append({"line": line, "toks": toks})
        toks = []

    while i < n:
        ch = body[i]
        if ch == "\n":
            flush(i)
            i += 1
            line_start = i
            continue
        if ch in (" ", "\t", "\r"):
            i += 1
            continue
        if ch == "#" and not toks:
            nl = body.find("\n", i)
            i = n if nl < 0 else nl
            continue
        key = None
        km = _KEY.match(body[i : i + 40])
        if km:
            key = km.group(1).lower()
            i += km.end()
        if body.startswith('"""', i):
            end = body.find('"""', i + 3)
            if end < 0:
                return {"error": 'unclosed """ block'}
            text = body[i + 3 : end]
            if text.startswith("\n"):
                text = text[1:]
            toks.append(_tok("str", text, key))
            i = end + 3
            continue
        if i < n and body[i] == '"':
            j = i + 1
            s = []
            while j < n:
                c = body[j]
                if c == "\\" and j + 1 < n:
                    nxt = body[j + 1]
                    s.append("\n" if nxt == "n" else nxt)
                    j += 2
                    continue
                if c == '"':
                    break
                if c == "\n":
                    return {"error": 'unclosed "string" (use """ for multi-line text)'}
                s.append(c)
                j += 1
            if j >= n:
                return {"error": 'unclosed "string"'}
            toks.append(_tok("str", "".join(s), key))
            i = j + 1
            continue
        if i < n and body[i] == "<":
            end = body.find(">", i)
            if end > i:
                toks.append(_tok("entity", body[i : end + 1], key))
                i = end + 1
                continue
        j = i
        while j < n and not _WS.match(body[j]):
            j += 1
        if j == i and not key:
            # Other whitespace (NBSP, \f, \v …). cmd.ts would make no progress here; skip it.
            i += 1
            continue
        toks.append(_tok("word", body[i:j], key))
        i = j
    flush(n)
    return out


# --------------------------------------------------------------------------------------------
# References


def parse_permalink(url: str):
    """scope.ts parsePermalink: host ends with .slack.com, path /archives/<C|G|D id>/p<10><6>."""
    try:
        u = urlsplit(url)
        host = u.hostname or ""
    except ValueError:
        return None
    if not u.scheme or not host.endswith(".slack.com"):
        return None
    m = _PERMALINK_PATH.match(u.path)
    if not m:
        return None
    ref = {"channel": m.group(1), "ts": f"{m.group(2)}.{m.group(3)}"}
    for part in u.query.split("&"):
        k, _, v = part.partition("=")
        if k == "thread_ts":
            if _THREAD_TS.match(v):
                ref["threadTs"] = v
            break
    return ref


def _message_ref(t):
    if not t:
        return None
    raw = t["text"][1:-1].split("|")[0] if t["kind"] == "entity" else t["text"]
    p = parse_permalink(raw)
    return {"channel": p["channel"], "ts": p["ts"]} if p else None


def _channel_ref(t):
    if not t:
        return None
    m = _CHANNEL_ENTITY.match(t["text"])
    if m:
        return m.group(1)
    return t["text"] if _CHANNEL_BARE.match(t["text"]) else None


def _user_ref(t):
    if not t:
        return None
    m = _USER_ENTITY.match(t["text"])
    if m:
        return m.group(1)
    return t["text"] if _USER_BARE.match(t["text"]) else None


def _at(toks, idx):
    return toks[idx] if idx < len(toks) else None


def _str(toks, idx):
    t = _at(toks, idx)
    return t["text"] if t and t["kind"] == "str" and not t.get("key") else None


def _prop(toks, key):
    for t in toks:
        if t.get("key") == key:
            return t["text"]
    return None


# --------------------------------------------------------------------------------------------
# Statements


def levenshtein(a: str, b: str) -> int:
    dp = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, len(b) + 1):
            tmp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (0 if a[i - 1] == b[j - 1] else 1))
            prev = tmp
    return dp[len(b)]


def _closest(word: str, options) -> str | None:
    best, best_d = None, 3
    for o in options:
        d = levenshtein(word, o)
        if d < best_d:
            best_d, best = d, o
    return best


def _effect(effect: dict, line: str) -> dict:
    return {"verb": "effect", "effect": effect, "line": line}


def parse_statement(line: str, toks: list) -> dict:
    verb = toks[0]["text"].lower()
    args = toks[1:]
    pos = [t for t in args if not t.get("key")]

    def err(msg: str) -> dict:
        return {"verb": "error", "error": msg, "line": line}

    if verb in ("done", "help"):
        return {"verb": verb, "line": line}

    if verb == "read":
        a = _at(pos, 0)
        if not a:
            return err("read needs a target: read thread | read channel [since=24h] | read <permalink>")
        if a["kind"] == "word" and a["text"] in ("thread", "channel"):
            rec = {"verb": "read", "target": a["text"], "line": line}
            since = _prop(args, "since")
            if since:
                rec["sinceText"] = since
            return rec
        ref = _message_ref(a)
        if not ref:
            return err(f'read: "{a["text"]}" is not thread, channel, or a Slack message link')
        return {"verb": "read", "target": ref, "line": line}

    if verb == "search":
        q = _str(pos, 0)
        if not q:
            return err('search needs a "quoted query"')
        return {"verb": "search", "query": q, "line": line}

    if verb == "reply":
        first = _at(pos, 0)
        if first and first["kind"] == "str":
            return _effect({"kind": "reply", "target": "scope", "text": first["text"]}, line)
        ref = _message_ref(first)
        text = _str(pos, 1)
        if not ref or not text:
            return err('reply "text" | reply <permalink> "text"')
        return _effect({"kind": "reply", "target": ref, "text": text}, line)

    if verb == "finding":
        ref = _message_ref(_at(pos, 0))
        text = _str(pos, 1)
        if not ref or not text:
            return err('finding <permalink> "text" [severity=high|medium|low]')
        sev = (_prop(args, "severity") or "").lower()
        if sev and sev not in ("high", "medium", "low"):
            return err("finding severity must be high, medium or low")
        eff = {"kind": "reply", "target": ref, "text": text}
        if sev:
            eff["severity"] = sev
        return _effect(eff, line)

    if verb == "post":
        channel = _channel_ref(_at(pos, 0))
        text = _str(pos, 1)
        if not channel or not text:
            return err('post <#channel> "text"')
        return _effect({"kind": "post", "channel": channel, "text": text}, line)

    if verb == "canvas":
        title, markdown = _str(pos, 0), _str(pos, 1)
        if not title or not markdown:
            return err('canvas "Title" """markdown"""')
        return _effect({"kind": "canvas", "title": title, "markdown": markdown}, line)

    if verb == "canvas-edit":
        cid = _at(pos, 0)
        markdown = _str(pos, 1)
        if not cid or cid["kind"] != "word" or not markdown:
            return err('canvas-edit <canvas-id> """markdown""" [section=<id> | heading="text"]')
        section = _prop(args, "section")
        heading = _prop(args, "heading")
        if section and heading:
            return err("canvas-edit takes section= or heading=, not both")
        eff = {"kind": "canvas-edit", "canvasId": cid["text"], "markdown": markdown}
        if section:
            eff["sectionId"] = section
        if heading:
            eff["heading"] = heading
        return _effect(eff, line)

    if verb == "action":
        owner = _user_ref(_at(pos, 0))
        text = _str(pos, 1) if owner else _str(pos, 0)
        if not text:
            return err('action <@person> "item" [due=YYYY-MM-DD]')
        due = _prop(args, "due")
        if due and not _DUE.match(due):
            return err(f'action: due "{due}" must be YYYY-MM-DD')
        eff = {"kind": "action-item", "text": text}
        if owner:
            eff["owner"] = owner
        if due:
            eff["due"] = due
        return _effect(eff, line)

    if verb == "schedule":
        channel = _channel_ref(_at(pos, 0))
        at = (_at(pos, 1) or {}).get("text")
        text = _str(pos, 2)
        if not channel or not at or not text:
            return err('schedule <#channel> <ISO-8601> "text"')
        if not ISO.match(at):
            return err(
                f'schedule: "{at}" is not an ISO-8601 time with an offset (e.g. 2026-10-12T09:00:00-07:00)'
            )
        return _effect({"kind": "schedule", "channel": channel, "at": at, "text": text}, line)

    if verb == "remind":
        user = _user_ref(_at(pos, 0))
        at = (_at(pos, 1) or {}).get("text")
        text = _str(pos, 2)
        if not user or not at or not text:
            return err('remind <@person> <ISO-8601> "text"')
        if not ISO.match(at):
            return err(f'remind: "{at}" is not an ISO-8601 time with an offset')
        return _effect({"kind": "remind", "user": user, "at": at, "text": text}, line)

    if verb == "bookmark":
        title = _str(pos, 0)
        link_tok = _at(pos, 1)
        link = None
        if link_tok:
            link = link_tok["text"][1:-1].split("|")[0] if link_tok["kind"] == "entity" else link_tok["text"]
        if not title or not link or not link.startswith("https://"):
            return err("bookmark \"Title\" <https://…>")
        return _effect({"kind": "bookmark", "title": title, "link": link}, line)

    if verb == "react":
        ref = _message_ref(_at(pos, 0))
        m = _EMOJI.match((_at(pos, 1) or {}).get("text", ""))
        if not ref or not m:
            return err("react <permalink> :emoji:")
        return _effect({"kind": "react", "target": ref, "emoji": m.group(1)}, line)

    if verb == "act":
        usage = 'act <connector>.<tool> "summary" """{json arguments}"""'
        target = _at(pos, 0)
        m = _ACT_TARGET.match(target["text"]) if target and target["kind"] == "word" else None
        summary = _str(pos, 1)
        raw = _str(pos, 2)
        if not m or not summary or raw is None:
            return err(usage)
        if len(raw.encode("utf-16-le")) // 2 > MAX_ACT_ARGS_CHARS:  # JS string length
            return err(f"act: arguments are limited to {MAX_ACT_ARGS_CHARS} characters")
        try:
            args_obj = json.loads(raw, parse_constant=_reject_constant)
        except ValueError:
            return err("act: arguments must be a JSON object")
        if not isinstance(args_obj, dict):
            return err("act: arguments must be a JSON object")
        return _effect(
            {
                "kind": "connector-action",
                "connector": m.group(1),
                "tool": m.group(2),
                "summary": summary,
                "arguments": args_obj,
            },
            line,
        )

    guess = _closest(verb, CMD_VERBS)
    return err(f'unknown verb "{verb}"' + (f' — did you mean "{guess}"?' if guess else ""))


# --------------------------------------------------------------------------------------------
# Program


def parse_program(response: str) -> dict:
    """cmd.ts parseProgram: {"lines", "errors", "done"} or {"fenceError": {...}}."""
    fence = extract_fence(response, "cmd")
    if not fence["ok"]:
        return {"fenceError": fence}
    stmts = split_statements(fence["body"])
    if isinstance(stmts, dict):
        return {"lines": [], "errors": [stmts["error"]], "done": False}
    lines = [parse_statement(s["line"], s["toks"]) for s in stmts]
    errors = [f'{l["line"]}: {l["error"]}' for l in lines if l["verb"] == "error"]
    return {"lines": lines, "errors": errors, "done": any(l["verb"] == "done" for l in lines)}


def summarize(response: str) -> dict:
    """The CLI shape: {ok, effects, reads, errors, done[, help, fenceError]}."""
    parsed = parse_program(response)
    if "fenceError" in parsed:
        reason = parsed["fenceError"]["reason"]
        return {"ok": False, "effects": [], "reads": [], "errors": [reason], "done": False, "fenceError": reason}
    reads, effects = [], []
    for l in parsed["lines"]:
        if l["verb"] == "effect":
            effects.append(l["effect"])
        elif l["verb"] in ("read", "search"):
            reads.append({k: v for k, v in l.items() if k != "line"})
    out = {
        "ok": not parsed["errors"],
        "effects": effects,
        "reads": reads,
        "errors": parsed["errors"],
        "done": parsed["done"],
    }
    if any(l["verb"] == "help" for l in parsed["lines"]):
        out["help"] = True
    return out


def main() -> int:
    result = summarize(sys.stdin.read())
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
