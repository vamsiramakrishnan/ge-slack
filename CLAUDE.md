# CLAUDE.md — Gemini Enterprise for Slack

Slack sibling of ge-msft. Same paradigm: seven verbs (`ask summarize explain rewrite review draft
notes`), `verb × scope × @ground` invocations, plan → approve → actuate → ledger, planner +
commander skills. Read before changing anything:

- `docs/EXPERIENCE.md` — the UX spec. UI/UX decisions are made here first; code follows it.
- `docs/ADR-0001-slack-architecture-and-dual-principal-identity.md` — identity (user via OIDC+WIF,
  licensed service account, keyless), membership gate, channel policy.
- `docs/ADR-0002-agents-connectors-and-skills.md` — how agents (`@alias`: chat agents, Deep
  Research, A2A), connectors and skills are invoked; agents answer, never write.
- `docs/STATUS.md` — what is verified (fakes) vs. not yet run live.

## Boundaries

- `contracts` owns payload shapes and pure policy (grammar, `decidePrincipal`, `canAutoApply`,
  `cmd`/`plan` parsers). The TS parsers are authoritative; `skill/*/scripts/*.py` mirror them —
  change TS first, then the mirror, then `skill/parity-corpus.jsonl`.
- `runtime` is surface-agnostic: it never calls Slack. Slack I/O goes through `SurfacePort` and
  `TurnSink`, implemented only in `slack-bridge`.
- Provider/identity transport lives in `gemini-client` and `identity`.
- `app` composes and wires Bolt; handler bodies stay in `handlers.ts` (testable without Slack).

## Non-negotiables

- Exactly one principal per turn, shown in every footer and stamped into provenance.
- The *human* must be a member of every conversation read or written; re-check at approval. The
  only exception is private, read-only workspace search over public channels (ADR-0001 §6).
- Slack content is untrusted data; model output is sanitized before landing (no broadcast
  mentions, no unknown user pings, targets only conversations named in the request).
- Writes require the invoker's approval, except unattended reply/post under `autoApply` policy.
- Never log or persist bearer tokens; only sealed IdP refresh tokens are stored.
- `GE_LOCATION` is required; no silent global fallback.

## Commands

```bash
bun install && bun run typecheck && bun run test && bun run test:skills && bun run lint
```
Done = all of those clean; run the `security-reviewer` agent after identity/provenance changes.
