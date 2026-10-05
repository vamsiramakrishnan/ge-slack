"""Unit tests for the skill preflight parsers (stdlib only).

Run from the repo root:
    python3 -m unittest discover -s skill -p 'test_*.py'

The TypeScript parsers in packages/contracts/src (cmd.ts, plan.ts, scope.ts) are authoritative.
These tests pin the Python mirrors to the same behavior, including the shared parity corpus
(parity-corpus.jsonl) that was cross-checked against cmd.ts.
"""

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLANNER = HERE / "slack-command-planner"
COMMANDER = HERE / "slack-surface-commander"
sys.path.insert(0, str(COMMANDER / "scripts"))
sys.path.insert(0, str(PLANNER / "scripts"))

import parse_commands as pc  # noqa: E402
import parse_plan as pp  # noqa: E402

PL = "https://acme.slack.com/archives/C0ENG/p1700000000123456"


def cmd(*lines: str) -> str:
    return "```cmd\n" + "\n".join(lines) + "\n```"


def plan(*lines: str) -> str:
    return "```plan\n" + "\n".join(lines) + "\n```"


class ExtractFenceTest(unittest.TestCase):
    def test_fails_closed(self):
        self.assertEqual(pc.extract_fence("no fence", "cmd"), {"ok": False, "reason": "no-fence"})
        self.assertEqual(pc.extract_fence(cmd("done") + "\n" + cmd("done"), "cmd")["reason"], "multiple-fences")
        self.assertEqual(pc.extract_fence('```cmd\nreply "x"', "cmd")["reason"], "unclosed-fence")

    def test_empty_body_and_trailing_space(self):
        self.assertEqual(pc.extract_fence("```cmd\n```", "cmd"), {"ok": True, "body": ""})
        self.assertEqual(pc.extract_fence("```cmd  \ndone\n```", "cmd"), {"ok": True, "body": "done"})

    def test_fence_must_start_a_line(self):
        self.assertEqual(pc.extract_fence('say ```cmd\ndone\n```', "cmd")["reason"], "no-fence")


class ParseProgramTest(unittest.TestCase):
    def test_every_effect_verb(self):
        r = pc.parse_program(
            cmd(
                "# observe",
                "read channel since=7d",
                f"read <{PL}>",
                'search "cache ttl"',
                'reply "Owners: \\"maya\\"\\nNext: li"',
                f'finding <{PL}> "No rollback plan" severity=high',
                'post <#C0DIG|digest> "Weekly digest"',
                'canvas "Incident follow-ups" """',
                "# Follow-ups",
                "- [ ] cache TTL",
                '"""',
                'canvas-edit F07ABC """## Status\\nDone""" section=temp:C:abc',
                'schedule <#C0LEAD> 2026-10-12T09:00:00-07:00 "Reminder"',
                'remind <@U0MAYA> 2026-10-07T17:00:00Z "Cache TTL change"',
                'bookmark "Runbook" <https://docs.acme.com/runbook>',
                f"react {PL} :white_check_mark:",
                "done",
            )
        )
        self.assertEqual(r["errors"], [])
        self.assertTrue(r["done"])
        effects = [l["effect"] for l in r["lines"] if l["verb"] == "effect"]
        self.assertEqual(
            [e["kind"] for e in effects],
            ["reply", "reply", "post", "canvas", "canvas-edit", "schedule", "remind", "bookmark", "react"],
        )
        self.assertEqual(effects[0], {"kind": "reply", "target": "scope", "text": 'Owners: "maya"\nNext: li'})
        self.assertEqual(effects[1]["severity"], "high")
        self.assertEqual(effects[1]["target"], {"channel": "C0ENG", "ts": "1700000000.123456"})
        self.assertEqual(effects[2]["channel"], "C0DIG")
        self.assertEqual(effects[3]["markdown"], "# Follow-ups\n- [ ] cache TTL\n")
        # """ blocks take no escapes: the backslash-n stays literal.
        self.assertEqual(effects[4]["markdown"], "## Status\\nDone")
        self.assertEqual(effects[4]["sectionId"], "temp:C:abc")
        self.assertEqual(effects[6]["user"], "U0MAYA")
        self.assertEqual(effects[8]["emoji"], "white_check_mark")
        self.assertEqual(r["lines"][0], {"verb": "read", "target": "channel", "sinceText": "7d", "line": "read channel since=7d"})

    def test_cli_style_errors_with_did_you_mean(self):
        r = pc.parse_program(cmd('repyl "x"', 'schedule <#C0A> tomorrow "x"', 'post "no channel"'))
        self.assertEqual(len(r["errors"]), 3)
        self.assertIn('did you mean "reply"', r["errors"][0])
        self.assertIn("ISO-8601", r["errors"][1])

    def test_unclosed_strings(self):
        self.assertTrue(pc.parse_program(cmd('reply "unterminated'))["errors"])
        self.assertEqual(pc.parse_program(cmd('canvas "T" """open'))["errors"], ['unclosed """ block'])

    def test_https_only_bookmarks(self):
        self.assertEqual(len(pc.parse_program(cmd('bookmark "x" <http://insecure.example.com>'))["errors"]), 1)

    def test_iso_requires_offset(self):
        self.assertEqual(len(pc.parse_program(cmd('remind <@U0A> 2026-10-07T17:00 "x"'))["errors"]), 1)
        self.assertEqual(pc.parse_program(cmd('remind U0ABC 2026-10-07T17:00Z "x"'))["errors"], [])

    def test_severity_values(self):
        self.assertEqual(pc.parse_program(cmd(f'finding <{PL}> "x" severity=LOW'))["errors"], [])
        self.assertEqual(len(pc.parse_program(cmd(f'finding <{PL}> "x" severity=urgent'))["errors"]), 1)

    def test_non_breaking_space_does_not_hang(self):
        r = pc.parse_program(cmd('reply "x"', "done"))
        self.assertEqual(r["errors"], [])


class PermalinkTest(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(pc.parse_permalink(PL), {"channel": "C0ENG", "ts": "1700000000.123456"})
        p = pc.parse_permalink(PL + "?thread_ts=1699999999.000100&cid=C0ENG")
        self.assertEqual(p["threadTs"], "1699999999.000100")
        self.assertIsNotNone(pc.parse_permalink("https://ACME.slack.com/archives/G0PRIV/p1700000000123456"))

    def test_invalid(self):
        for bad in (
            "https://acme.slack.com.evil.io/archives/C0ENG/p1700000000123456",
            "https://slack.com/archives/C0ENG/p1700000000123456",
            "https://acme.slack.com/archives/C0ENG/p170000000012345",
            "https://acme.slack.com/archives/U0ENG/p1700000000123456",
            "https://acme.slack.com/archives/C0ENG/p1700000000123456/extra",
            "acme.slack.com/archives/C0ENG/p1700000000123456",
            "https://acme.slack.com/archives/C0ENG/p17000000001234٥٦",
        ):
            self.assertIsNone(pc.parse_permalink(bad), bad)

    def test_bad_thread_ts_is_dropped(self):
        self.assertNotIn("threadTs", pc.parse_permalink(PL + "?thread_ts=1.2"))


class ParityCorpusTest(unittest.TestCase):
    def test_corpus(self):
        rows = [json.loads(l) for l in (HERE / "parity-corpus.jsonl").read_text().splitlines() if l.strip()]
        self.assertGreaterEqual(len(rows), 15)
        self.assertTrue(any(r["ok"] for r in rows) and any(not r["ok"] for r in rows))
        for row in rows:
            with self.subTest(row["id"]):
                got = pc.summarize(row["program"])
                self.assertEqual(got["ok"], row["ok"])
                self.assertEqual([e["kind"] for e in got["effects"]], row["kinds"])
                self.assertEqual(len(got["reads"]), row["reads"])
                self.assertEqual(len(got["errors"]), row["errors"])
                self.assertEqual(got["done"], row["done"])
                self.assertEqual(got.get("fenceError"), row.get("fenceError"))


class ParsePlanTest(unittest.TestCase):
    def test_full_plan_and_confirmed_render(self):
        r = pp.parse_plan_block(
            "Here:\n"
            + plan(
                "intent draft",
                "surface slack",
                "scope channel <#C0ENG|eng>",
                'ground "Runbooks"',
                "step summarize decisions",
                "step post owners",
                "exclude anything about hiring",
                "confidence high",
            )
        )
        self.assertTrue(r["ok"], r)
        p = r["plan"]
        self.assertEqual(p["scope"], {"kind": "channel", "ref": "<#C0ENG|eng>"})
        self.assertEqual(p["ground"], ["Runbooks"])
        self.assertEqual(len(p["steps"]), 2)
        self.assertFalse(r["needsClarification"])
        rendered = pp.render_confirmed_plan(p)
        self.assertIn("exclude anything about hiring", rendered)
        self.assertIn("scope channel <#C0ENG|eng>", rendered)
        self.assertNotIn("confidence", rendered)

    def test_requires_steps_or_clarify_and_slack(self):
        self.assertEqual(
            pp.parse_plan_block(plan("intent ask", "surface slack"))["error"],
            "a plan needs at least one step or a clarify question",
        )
        self.assertFalse(pp.parse_plan_block(plan("intent ask", "surface word", "step x"))["ok"])
        self.assertFalse(pp.parse_plan_block(plan("intent ask", "step x"))["ok"])
        c = pp.parse_plan_block(plan("intent draft", "surface slack", "clarify which channel?"))
        self.assertTrue(c["ok"] and c["needsClarification"])

    def test_key_and_value_validation(self):
        self.assertEqual(
            pp.parse_plan_block(plan("intent ask", "surface slack", "step x", "target y"))["error"],
            'unknown plan key "target"',
        )
        self.assertIn("Invalid enum", pp.parse_plan_block(plan("intent visualize", "surface slack", "step x"))["error"])
        self.assertEqual(pp.parse_plan_block(plan("surface slack", "step x"))["error"], "Required")
        self.assertIn("Invalid enum", pp.parse_plan_block(plan("intent ask", "surface slack", "step x", "confidence maybe"))["error"])

    def test_case_comments_and_brackets(self):
        r = pp.parse_plan_block(plan("plan", "# note", "", "INTENT Notes", "Surface SLACK", "step x", "end"))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["plan"]["intent"], "notes")

    def test_fence_rules(self):
        self.assertEqual(pp.parse_plan_block("no fence")["error"], "no-fence")
        self.assertEqual(pp.parse_plan_block(plan("intent ask") + "\n" + plan("intent ask"))["error"], "multiple-fences")
        self.assertEqual(pp.parse_plan_block("```plan\nintent ask\nsurface slack\nstep a")["error"], "unclosed-fence")


def _fences(text: str, lang: str):
    return re.findall(r"(?:^|\n)(```" + lang + r"[ \t]*\n.*?\n```)", text, flags=re.S)


class BundledExamplesTest(unittest.TestCase):
    """Every ```cmd / ```plan example shipped in a skill must pass its own preflight."""

    def test_commander_examples_parse(self):
        files = [COMMANDER / "SKILL.md", *sorted((COMMANDER / "patterns").glob("*.md"))]
        count = 0
        for f in files:
            for block in _fences(f.read_text(), "cmd"):
                count += 1
                with self.subTest(f.name, block=block[:60]):
                    r = pc.summarize(block)
                    self.assertTrue(r["ok"], r["errors"])
                    self.assertTrue(r["done"])
        self.assertGreaterEqual(count, 4)

    def test_planner_examples_parse(self):
        blocks = _fences((PLANNER / "SKILL.md").read_text(), "plan")
        self.assertGreaterEqual(len(blocks), 4)
        for block in blocks:
            with self.subTest(block=block[:60]):
                r = pp.parse_plan_block(block)
                self.assertTrue(r["ok"], r)

    def test_frontmatter(self):
        for d in (PLANNER, COMMANDER):
            text = (d / "SKILL.md").read_text()
            self.assertTrue(text.startswith("---\n"))
            front = text.split("---\n", 2)[1]
            self.assertIn(f"name: {d.name}\n", front)
            self.assertIn("description:", front)


class CliTest(unittest.TestCase):
    def run_cli(self, script: Path, stdin: str):
        p = subprocess.run([sys.executable, str(script)], input=stdin, capture_output=True, text=True, check=False)
        return p.returncode, json.loads(p.stdout)

    def test_commands_cli(self):
        code, out = self.run_cli(COMMANDER / "scripts" / "parse_commands.py", cmd("read thread", 'reply "ok"', "done"))
        self.assertEqual(code, 0)
        self.assertEqual(set(out), {"ok", "effects", "reads", "errors", "done"})
        self.assertEqual(out["reads"], [{"verb": "read", "target": "thread"}])
        code, out = self.run_cli(COMMANDER / "scripts" / "parse_commands.py", "prose only")
        self.assertEqual((code, out["ok"], out["fenceError"]), (1, False, "no-fence"))

    def test_plan_cli(self):
        code, out = self.run_cli(PLANNER / "scripts" / "parse_plan.py", plan("intent notes", "surface slack", "step x"))
        self.assertEqual((code, out["ok"]), (0, True))
        code, out = self.run_cli(PLANNER / "scripts" / "parse_plan.py", plan("intent notes", "surface slack"))
        self.assertEqual((code, out["ok"]), (1, False))


if __name__ == "__main__":
    unittest.main()
