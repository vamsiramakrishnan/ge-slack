# Bounded Slack evidence and durable effect attempts

This increment applies the verified-execution lessons from ge-msft to the existing Slack ports,
principal policy, commander and ledger. Slack remains the host; there is no Office dependency,
parallel write executor or arbitrary code execution channel.

## Source capture and model visibility

| Boundary | Limit and behavior |
| --- | --- |
| Native capture | At most 200 messages, eight native pages and 256 KiB of UTF-8 JSON per capture, excluding coverage metadata. |
| Retained working set | At most 400 message records and 256 KiB of serialized working evidence. Message identity includes channel and timestamp; observed edits replace the previous record. |
| Model source window | At most 60 KiB including delimiters, metadata, messages, canvas and coverage notes. Clipping and omissions are explicit. |
| Other model data | Memory, connector documentation and feedback each fit 16 KiB. The complete prompt fits 128 KiB; oversized trusted task/plan instructions cause a refusal instead of silent truncation. |
| Additional reads | Eight per executor task. Handles are bound to the source, native continuation and author filter in that task; a new task cannot reuse them. |

Capture reports traversal direction and known lower bounds on omissions. Replies are paged oldest
first; history is retrieved newest first and may be displayed chronologically. Ranked workspace
search is partial evidence, never a claim that all workspace content was read. A canvas preview
and clipped markdown remain partial. Slack's canvas endpoint may return its full body over the
network; this implementation bounds retained/output content and does not invent native range APIs.

The bridge stops cursor cycles and bounded empty-page scans. An in-page offset preserves records
excluded by a message/byte budget, so continuation does not skip them. Exact-message fallback
requires the requested timestamp and never substitutes a neighboring history message.

The commander uses `read next cursor=p_…` only when the current context supplies that handle.
Native cursors never reach the model. Reads retain author filters and cannot expand a thread into
channel history, exceed the admitted time window or use arbitrary cross-thread permalinks. Every
additional read rechecks current human membership, metadata, principal policy and service scope.
A read-only program ending in `done` returns its results to the next model turn; standalone `done`
finishes normally. `search` searches only the retained evidence.

## Freshness and destructive changes

New source-derived plans carry server-owned receipts: admitted scope/options and content hashes,
not source bodies or bearer credentials. Stored plan/answer/resume origins also strip Slack
response hooks and modal triggers; legacy rows are sanitized on return and should expire or be
purged under the operator's retention policy. Before dispatch, the runtime rechecks current source
access and recaptures the bounded windows. A changed source or failed read prevents the write.
Older source-derived plans without receipts must be drafted again.

A native-complete canvas is not necessarily model-complete. `renderContextWindow` measures what
actually fits in the model prompt. Canvas replacement requires both complete native capture and
complete model visibility, plus a fresh matching source fingerprint. Preview-only or prompt-clipped
canvases cannot authorize replacement. Other inspected messages may have been evicted from the
working window; omission metadata is not permission to infer their contents.

Intentional sharing/posting of an exact stored answer is approval of that artifact; it does not
assert its sources remain current. These explicit snapshot paths are distinct from source-derived
plans. Principal pins additionally hash the IdP subject/provider, workspace and Slack actor;
service pins bind the configured service account and initiating actor. Display/provenance labels
remain separate. Pending agent continuations use the same immutable binding.

Slack offers no source compare-and-swap or cross-object transaction. A source can change after the
final check. Append-only effects within one approved batch do not repeatedly invalidate themselves
by adding their own replies; destructive canvas changes receive another freshness check. These
checks reduce stale decisions and do not establish atomic coauthoring protection.

## Durable attempts and receipts

`KeyValueStore.create` is an atomic create-if-absent contract. Memory implements local atomicity;
Firestore uses native document creation. An adapter without this operation cannot perform writes.
Claims bind team, change ID, invoker, immutable principal hash, intent hash and phase. They contain
bounded metadata, not tokens, source excerpts or binary payloads. They do not expire into replay
authority. The existing ledger still owns provenance and operation-specific inverse descriptors.

Every Slack/connector write claims its effect and records uncertainty before dispatch. Fresh
membership, metadata, principal and current trust/auto/connector policy checks bracket durable I/O.
A duplicate claim, existing legacy receipt or failed preflight prevents dispatch. A known successful
receipt survives a final checkpoint failure; remaining effects stop rather than retrying it.
Mismatched receipt IDs/kinds discard foreign locations and inverses. Undo has its own claim and
fresh authority check; a recorded reminder cancellation does not grant access to the recipient DM.

FAQ publication uses a curator-scoped claim. Every source must still be allowed, public, internal
and readable by the drafter immediately before publication. Steward authority is checked again
after durable waits, including removal. Content-bearing FAQ cards only reach a freshly checked
private internal steward channel. A visibility change does not prevent authorized removal of an
already published FAQ. Known publication/removal outcomes are preserved through checkpoint failure.

Scheduled slots and stable keyword/reaction event identities have separate durable run claims,
before new effect IDs are minted. Distinct reaction events remain distinct; missing stable event
identity fails closed. Deliberate owner **Run now** remains a new request. Debounce is an efficiency
filter, not a distributed cooldown. A crash after claiming can leave an uncertain attempt or
scheduled slot blocked for operator inspection. Do not delete claims to implement an automatic
retry; reconcile the target, ledger and schedule first, then authorize a deliberate new attempt.

These are at-most-once attempts for a stable identity, not exactly-once delivery, automatic task
DAG replay, cross-change-ID intent deduplication or a complete recovery UI.

## Verification and deployment

Run the repository gates:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:skills
bun run lint
bun run manifest:check
skill/build_zip.sh slack-command-planner
skill/build_zip.sh slack-surface-commander
python3 skill/validate_bundles.py
python3 -m unittest discover -s deploy -p 'test_*.py'
```

The TS grammar remains authoritative; Python mirrors and the shared corpus include continuation
cases. Archive validation compares every bundled byte to source. `/gemini diag` reports source,
prompt and read limits plus atomic-claim support and declared store durability without exporting
claim records or source content.

Tests use recording Slack/provider APIs and Memory/Firestore adapter doubles. They establish the
contracts and failure behavior, not tenant acceptance. Live Slack rendering, cursor behavior,
Firestore concurrency/emulator acceptance, rate-limit behavior and Gemini quality remain required
checks in `LIVE-TESTING.md`. No live Slack message or provider action was performed by this update.


Local verification for this change passed 399 Vitest tests, 24 Python parser tests and four deploy
renderer tests, plus TypeScript, lint, manifest validation and exact-source archives. The updated
commander skill passed the official format validator and an isolated forward-test on a partial
incident thread, requesting its supplied continuation before proposing notes. No live tenant was
used for that forward-test.
