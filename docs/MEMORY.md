# Local memory, Compact, and Dream

Local subscription mode now owns memory without CopilotKit Intelligence. CopilotKit's open-source chat/runtime libraries remain in use. Storage stays local; model prompts still go to your selected subscription provider. Voice work is deferred.

## Using it

Open **Memories** to add or inspect facts and procedures. Filter by scope, type, or status. Pin a small set of essentials to include them in every turn. Other active records and indexed conversation excerpts are available through `search_memory`, `read_memory`, and `read_memory_source` when a Dot needs them. Original evidence and revision history are available in the details view.

Edit a Dot and open **Local memory and learning**. **Use saved memories** controls access; **Learn from new conversations** separately opts that Dot into persistent learning. Global memory permission takes precedence. Automatic Compact is on by default, even when learning is off. Automatic Dream is enabled in the learning settings but only runs after learning is enabled.

| Action  | Manual                                                  | Automatic default                                                                                                                               |
| ------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact | `/compact` or **Compact now** in Memory activity        | After a completed turn reaches 75% of the input budget, or after two idle minutes with eight new completed exchanges or 4,000 new context units |
| Dream   | `/dream` or **Dream now**                               | Every two hours with new eligible evidence and five idle minutes; at most four admissions per Dot per configured local day                      |
| Inspect | `/dream-log` or **Memory activity**                     | Job states and change receipts persist across restart                                                                                           |
| Restore | `/dream-restore <change-set-id>` or **Preview restore** | Always requires a preview and explicit confirmation; newer conflicting revisions block it                                                       |

Commands must be the entire message. Quoted or embedded commands remain normal conversation text. Commands use authenticated application routes and do not fabricate assistant messages. Failed command requests preserve the draft.

A manual Dream while learning is off is a one-time review-only pass. It does not enable ongoing learning. To consider retained older conversations, explicitly select them under **Review older conversations**. Routine Dream starts at the most recent learning enrollment boundary. Old unguarded history remains owner-readable but is excluded from automatic evidence use because its original permissions cannot be established.

## What Dream may learn

Dream consumes bounded batches of original evidence, can look up existing memory, and proposes changes. Hybrid publication automatically activates narrowly verified, direct first-person preferences using their complete original message. A clipped or quoted fragment stays reviewable. Other supported facts and all procedures require review. Procedures need two distinct successful or explicitly endorsed episodes. Assistant guesses, quoted instructions, recalled memories, and unsuccessful tool attempts do not establish user preferences or successful procedures.

Corrections supersede prior records. Owner-pinned records and concurrent manual edits are protected. Dream cannot edit role instructions, permissions, tool configuration, or arbitrarily broaden sharing. Sharing is an explicit owner action for the selected memory and its cited excerpts; it does not grant an entire private conversation. Current Space/page permissions still apply.

Rejecting, forgetting, or reversing newly learned evidence suppresses its future recall and removes linked evidence from model projections. The original transcript and audit history remain available to the owner. **Forget is not physical deletion.** Known recalled copies and their dependent checkpoints are withheld too. An independently restated paraphrase without a recorded dependency may remain; this is not a promise of semantic erasure. Restoring a forget or rejection releases only that operation’s suppression; a separate forget remains effective. Deleting a source page makes its derived memory unavailable. Later genuinely new evidence may support a new proposal.

## Context and speed

The default input budget is 24,000 estimated units, with at most 2,000 for pinned essentials. Estimation currently uses one UTF-8 byte per token as a deliberately conservative fallback; these are not provider token-usage counts. Set `MEMORY_INPUT_TOKEN_LIMIT` and `MEMORY_PINNED_TOKEN_LIMIT` only when the chosen model can accommodate them.

Compact creates a source-backed checkpoint containing the current goal, constraints, decisions, completed work, questions, and next steps. Recent messages and unresolved tool-call/result groups remain intact. Canonical messages, tool IDs, approvals, and run events are never rewritten by compaction. A large indivisible input can still exceed capacity; shorten it or start a new conversation if Compact cannot safely make room.

Recall uses SQLite FTS5 and PostgreSQL full-text indexes without model calls or embeddings. Results are bounded, paginated, permission-checked, and cached briefly. Search is lexical: a query such as “arrival deadline” may miss “delivery.” Dots can retry with another term and read original evidence. A failed search does not prove an event never happened; coverage reports when indexing is partial.

Foreground chat reserves the app's inference scheduler and cancels background inference when necessary. The shared CLI can still be busy with another application outside Dots. Each maintenance job allows at most three model calls and five minutes, shared across up to two retries at 30 and 120 seconds. Limits and publication policy are snapshotted when admitted. Disabling learning or permissions cancels affected work. Startup schedules bounded work rather than replaying every missed interval.

Maintenance checks at most 25 conversation boundaries per tick and caches unchanged boundaries. Indexing processes up to five guarded completed runs at a time. Persisted scan positions advance past inaccessible evidence without marking it processed. Chunks are bounded by UTF-8 bytes, including CJK text. Automatic Dream skips evidence from approval-blocked conversations and rechecks this before execution. A very large individual run can still require substantial indexing work.

## Storage and recovery

- `DATABASE_PATH` (normally `data/opendots.sqlite`): curated memory, revisions, learning settings, source suppressions/grants, restore previews, and atomic change receipts alongside existing workspace data.
- `LOCAL_DATABASE_URL` / PostgreSQL: canonical conversations, run evidence and events, search chunks, checkpoints, durable maintenance jobs and leases, daily admission counts, and processed-evidence receipts.
- Process memory: bounded recall/context caches and timing samples; these are rebuilt after restart.

Existing explicit memories are imported once with their original IDs, text, and timestamps, as active unpinned owner-shared records. The local legacy `/memories` endpoints forward to this canonical store; hosted compatibility keeps its prior behavior. Back up both SQLite and PostgreSQL together, keep `OWNER_ID` stable, and stop the app for a consistent backup. Include SQLite's WAL when taking a live filesystem snapshot. Do not delete Docker volumes to fix credentials.

A Dream publication and its receipt commit atomically in SQLite. PostgreSQL acknowledges processed evidence afterward. On restart, an existing receipt is reconciled before any repeated inference or budget sweep. Lease fencing prevents a stale worker from publishing. Restore writes new revisions and never rewinds conversation history or processed-evidence cursors.

## Verification and measured limits

October 17, 2026, Apple M3 Max, Node 24.20.0, local Docker PostgreSQL:

| Local operation  | Cold p50 / p95 | Warm p50 / p95 |
| ---------------- | -------------- | -------------- |
| Recall           | 9.6 / 11.9 ms  | 0.8 / 1.5 ms   |
| Context assembly | 14.7 / 30.7 ms | 5.9 / 7.9 ms   |

The benchmark seeds 10,000 memories and 100,000 messages across 100 threads, with 1,000 messages in the active compacted thread. Thirty samples per category use actual application services. “Cold” creates a fresh service cache; OS/database caches are not flushed. One broad archived-message search took 56.9 ms. The 100 ms recall and 200 ms context targets passed for this dataset. These results exclude live provider latency and are not a guarantee for every archive or machine.

Run `LOCAL_TEST_DATABASE_URL=... npm run benchmark:memory`. The script requires a database name containing `test`, rejects a URL matching `LOCAL_DATABASE_URL`, uses a randomized owner namespace and temporary SQLite files, and removes its own records afterward. Never point it at production.

Timing instrumentation records bounded numeric samples for recall, context, provider queue, provider execution, tool-result round trips, and total turns. It does not retain prompts or memory content. Empty stages in a benchmark are reported as unmeasured, not zero latency.

All 475 tests in 89 files pass. Type checking, lint, formatting, and the production build also pass. Automated tests use the real npm/Python subprocess and SSE transport with deterministic fixture inference. They cover short-chat learning, exact identifiers and Unicode, correction after restart, reviewed procedure recall, pending approval continuation after compaction, suppression, and an injected failure between publication and acknowledgement. Fixture final-answer checks establish data flow, not general model reasoning quality. Lexical paraphrase misses are explicitly tested and documented; embeddings are deferred.

A separate tool-free live Codex Compact smoke returned schema-valid output in **6.49 seconds**, retaining `REQ-731`, the exact budget of `456`, and the approval constraint. This verifies the current installed Codex path only. Browser checks covered the memory and learning controls at desktop and 390-pixel widths. Other providers and long-running autonomous learning still need live evaluation.

## Inspiration

The design was informed by [nanobot's memory implementation at the inspected revision](https://github.com/HKUDS/nanobot/tree/559107172a39b22bda0c4a2d3b58d9e63e0ea32d): separate compaction from Dream consolidation, process incremental evidence, retain change history, and offer manual and scheduled execution. Dots adapts those ideas to its SQLite/PostgreSQL storage, structured proposals, permission checks, atomic receipts, and retrieval-first context. Nanobot was source-inspected, not installed or executed.
