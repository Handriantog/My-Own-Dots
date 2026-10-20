# Unified Workspace Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make core Dot data independent of Docker, preserve existing workspaces through explicit migration, and measure typed/voice behavior before enabling the new default.

**Architecture:** A backend storage worker owns core SQLite handles and serializes bounded repository operations with foreground priority. Existing synchronous repository implementations stay inside that worker; asynchronous typed clients serve the backend. Legacy PostgreSQL remains available for current workspaces and migration. Workspace identity and location are persisted separately from runtime code.

**Tech Stack:** Node 24 SQLite/worker threads, TypeScript, Zod, FTS5, Electron, existing PostgreSQL adapter, stage-one archives/maintenance/journals, Vitest and deterministic provider/audio fixtures.

**Spec:** [Approved storage design](storage-portability-design.md); [overview and performance gates](storage-implementation-plan.md).

The owner already approved this scope and inline execution. This plan elaborates stage two using the implemented backup interfaces; it does not request a new design approval or authorize deleting source data.

## Global Constraints

- Preserve all selected workspace directories, original SQLite stores and PostgreSQL volumes. Migration is explicit; no silent switch of an existing workspace.
- Normal installs use platform data directories; portable roots keep `workspace/` and `desktop-profile/` alongside program files, outside executable bundles and updater directories. Existing selections take precedence. A missing selected root is an error, never a new empty workspace.
- One backend owner per canonical workspace path. The worker owns every core database write, including existing workspace/memory/permission/voice/settings stores. No database/network/provider work on Electron's main thread and no synchronous database calls on the backend voice event loop.
- WAL, foreign-key enforcement, versioned migrations, `synchronous=FULL`; no inference, network calls or tool execution inside transactions. Bounded requests and short transactions with foreground priority.
- Persist events before display or speech; fence expired/cancelled leases; recover interrupted work without replaying external actions.
- Reference corpus: at least 10,000 memories and 100,000 messages across 100 threads, including a 1,000-message active conversation. Measure at least 100 warm turns per case, after warmup, repeated in independent processes.
- Recall/context p95 at most 100/200 ms; foreground persistence p95 at most 25 ms on the reference SSD. Typed first-text and voice software-playback p50/p95 increases at most the larger of 5% or 50 ms against a matched baseline, including background work.
- Keep model, prompt, context, voice and provider-session settings fixed. Fixture playback acknowledgement is not audible-onset or native-platform acceptance. Do not enable the SQLite default until migration/correctness/performance checks pass.

## Review Focus

- A selected disk disappears or a portable root moves: retain identity and show recovery instead of opening an empty workspace (tasks 1 and 7).
- A stale worker or thread lease finishes after cancellation: reject its durable event or Dream publication, including acknowledgements (tasks 2–4).
- A large history or maintenance queue competes with voice: bounded indexed reads and foreground admission preserve commit-before-playback (tasks 3–5 and 8).
- A crash occurs during source capture, SQLite import or selection publication: only the original or fully verified new database becomes active (task 6).
- Permissions change while source evidence is indexed or recalled: SQL scope filters, suppression rules and final permission checks continue to exclude inaccessible data (tasks 4–5).

## File boundaries

New workspace resolution and manifests: `src/shared/workspace-manifest.ts`, `src/desktop/host/workspace-location.ts`. Storage protocols/worker/clients: `src/server/storage/{repository-contract,storage-worker,storage-client,sqlite-schema,sqlite-conversations,sqlite-evidence,sqlite-jobs}.ts`. Keep SQL and transaction ownership there; orchestration remains in Platform, memory maintenance, runner, routes and voice services. Migration and unified snapshots: `src/server/storage/{migrate-workspace,unified-snapshot}.ts`; reuse the existing archive and journal services. Benchmarks: `scripts/benchmark-workspace-storage.mjs` and deterministic fixtures under `tests/fixtures/`.

## Task 1: Stable workspace identity and location

**Files:** Create manifest/location modules and `tests/desktop/workspace-location.test.ts`; modify workspace-backend/identity/main configuration and their tests only as needed to consume the resolver without changing existing backend selection.

**Interfaces:** `WorkspaceManifest = { version: 1; id: string; ownerId: string; storage: 'legacy-postgres' | 'sqlite'; schema: number }`. `resolveWorkspaceLocation({ platform, home, localAppData?, xdgDataHome?, electronData, selected?, portableRoot?, executable }): { workspace, profile, portable }`. `readWorkspaceManifest(directory)` never initializes data; `createWorkspaceManifest(directory,input)` exclusively creates and fsyncs a validated file. IDs survive path changes; runtime exclusion still keys canonical database path.

- [ ] Write tests for macOS Application Support, Windows LOCALAPPDATA, Linux XDG/fallback and explicit portable roots. Assert normal Windows data is not roaming, portable paths are outside `.app`/AppImage mounts, and an explicit selection always wins. Test missing/read-only selected roots, malformed/absolute/escaping portable marker paths and moving the whole portable root with unchanged manifest ID.
- [ ] Run the location/identity/backend tests; expect missing resolver/manifest failures.
- [ ] Implement versioned manifests and canonical location resolution. Preserve old path-based identity for a legacy workspace until its explicit manifest transition; do not mutate existing stores on read. Never derive a portable root from cwd.
- [ ] Run focused tests and typecheck; expect pass with no changes to existing data. Commit `feat: persist workspace identity and locations`.

## Task 2: Worker-owned repository coordinator

**Files:** Create repository-contract/storage-worker/storage-client and their tests; extend runtime bundling. Modify Store/WorkspaceStore constructors to accept worker-owned SQLite configuration without changing external behavior yet.

**Interfaces:** `StoragePriority = 'foreground' | 'background'`; `StorageClient.open({ database, ownerId }): Promise<StorageClient>`; `client.call<K extends RepositoryMethod>(method: K, args: RepositoryArguments<K>, { signal?, priority? }): Promise<RepositoryResult<K>>`; `client.close(): Promise<void>`. `RepositoryMethod` is an explicit allowlist of typed repository operations, never SQL or arbitrary property traversal. `client.repositories` provides typed async facades for Store, WorkspaceStore and their memory/history/pages/computers/connections/folder repositories. Owner ID is immutable metadata, not an RPC.

- [ ] Write worker tests asserting cancelled queued requests never mutate, aborted in-flight writes acknowledge only after commit/rollback, a foreground request precedes queued background batches, worker death rejects all pending calls, and the caller's event loop remains responsive under a held external database lock. Reject unknown methods and oversized payloads before enqueueing.
- [ ] Run focused tests; expect missing worker failures.
- [ ] Implement a bounded queue (1,024 requests, 16 MiB/request), explicit method dispatch and async clients. Keep existing repository classes and all SQLite handles within the worker. Set foreign keys/FULL on each handle, avoid a multi-second busy wait, and retry a busy background transaction through the queue rather than blocking foreground. Never serialize callbacks or AbortSignals. Exclude callback-taking transaction helpers such as `MemoryStore.atomic` from RPC; task 4 exposes compound transactional operations instead. Close/drain before terminating.
- [ ] Run worker, existing repository and packaged-worker tests plus typecheck; expect no database calls on the parent thread. Commit `feat: coordinate core storage in a worker`.

## Task 3: Incremental SQLite conversations and fenced leases

**Files:** Create sqlite-schema/sqlite-conversations and tests; extract shared conversation/replay contracts from local-conversations only where required. Adapt `LocalConversationStore` to include the existing listing/message/state endpoints used by Platform/PageService.

**Interfaces:** `SQLiteConversations` implements the same asynchronous conversation API as `PostgresConversations`, including `ThreadLease`. Internal worker tables store owner/thread/run/message/event IDs, sequence, payload and lease generation explicitly. `initializeSQLiteSchema(db)` applies numbered transactions; event and message bodies remain canonical JSON with stable IDs. `acquireThread` returns null for an active owner and a generation-fenced lease otherwise.

- [ ] Parameterize the conversation contract tests across real PostgreSQL and SQLite. Assert pending client-tool behavior, append-before-emit, two concurrent independent threads, overlapping same-thread rejection, stale lease expiry, crash interruption, terminal event uniqueness and reconstruction after restart.
- [ ] Run SQLite cases; expect missing adapter failures.
- [ ] Implement short fenced transactions and indexed incremental event/message rows. Append does not rewrite the full event history. Keep provider calls/replay outside the worker transaction. A stale release never removes a newer lease; late appends/finalization fail. Preserve owner scoping and client-history validation.
- [ ] Run conversation/runner/voice persistence tests and worker queue tests; expect identical durable ordering. Commit `feat: store conversations in workspace SQLite`.

## Task 4: SQLite evidence, recall and maintenance jobs

**Files:** Create sqlite-evidence/sqlite-jobs; introduce typed repository interfaces in conversation-memory/memory-jobs; move raw PostgreSQL queries out of memory-maintenance into adapter methods. Extend schema and tests for evidence/checkpoints/jobs/FTS5.

**Interfaces:** `ConversationEvidenceRepository` contains the existing ConversationMemory public methods plus explicit maintenance queries for eligible threads/runs/sources and compact snapshots. `MemoryJobRepository` preserves enqueue/find/list/claim/renew/usage/defer/settle/admission semantics. Replace callback-based `withLease` publication with `publishDream(input: { jobId: string; lease: string; generation: number; proposal: DreamProposal; policy: PublicationPolicy; dotId: string }): Promise<ApplyReceipt>` (proposal/policy/receipt types from `src/shared/memory.ts`), committing memory changes, receipt and evidence acknowledgement together in SQLite.

- [ ] Run the same evidence, checkpoint, job and publication cases against both adapters. Add FTS5 scope/suppression cases, missing evidence, stale checkpoint hashes, expired job leases, concurrent admission limits and crash after publication-before-ack. Assert idempotent receipt and no double publication.
- [ ] Run SQLite adapter tests; expect missing implementations.
- [ ] Implement FTS5 plus indexed owner/Dot/thread/source filters; apply final access/dependency checks before returning evidence. Rebuild derived indexes in bounded batches. Preserve source hashes, forgotten/rejected suppressions, revision history, daily budgets and processed-source receipts. Do not assume PostgreSQL ranking equivalence.
- [ ] Run memory recall/context/jobs/publication/access suites; expect equivalent permission/correctness outcomes and no replay. Commit `feat: consolidate memory evidence and jobs`.

## Task 5: Async repositories throughout runtime

**Files:** Modify platform/index/app, runner, dot-agent, all workspace/memory/folder/computer/connection/page routes/services, setup telemetry, local/remote voice and related tests. Consume task 2's async facades and task 3–4's adapter contracts; keep synchronous classes confined to worker/tests/controlled offline migration.

**Interfaces:** `Platform.create(...)` performs asynchronous repository initialization before exposing routes; Store and Workspace contracts return Promises for database operations. Services that need callbacks use async callbacks or immutable initialized metadata, never synchronous IPC. Existing HTTP/AG-UI/voice payloads remain unchanged. `CONVERSATION_BACKEND=local` plus manifest engine chooses legacy PostgreSQL or unified SQLite explicitly.

- [ ] Add runtime tests exercising conversation, page write, permission revocation, scheduled task, telemetry flush, Dream publication, voice final receipts and shutdown through the real storage worker. Assert a delayed/revoked permission cannot authorize an external tool and no speech precedes event persistence.
- [ ] Run these tests before conversion; expect missing async worker integration failures.
- [ ] Convert call sites end-to-end; await compound reads before permission decisions and hold maintenance admission through detached writes. Do not use `Atomics.wait`, a synchronous worker bridge or unawaited mutations. Move policy reads needed for inference into bounded snapshots and revalidate before durable/external actions.
- [ ] Run the whole suite, typecheck, lint and both builds. Grep production startup paths for DatabaseSync construction outside worker/offline services. Expect no remaining synchronous core database paths in the backend event loop. Commit `refactor: route runtime storage through async repositories`.

## Task 6: Verified unified snapshots and explicit legacy migration

**Files:** Create migrate-workspace/unified-snapshot and tests; extend archive manifest parsing, restore validators and worker commands; add native preview/migrate IPC and StorageSettings controls.

**Interfaces:** `MigrationService.prepare({ source, backupDestination, passphrase, signal }): Promise<MigrationPreview>`; preview has opaque operation ID, source identity, counts, coverage and warnings. `activate(operationId,signal)` requires a fresh verified pre-migration backup and exclusive source ownership. Archive manifests gain version 2 with an explicit SQLite storage/schema descriptor; reader continues to support version 1 legacy archives. Unified restore uses one SQLite snapshot and needs no PostgreSQL connection.

- [ ] Seed real legacy SQLite/PostgreSQL with all canonical record classes. Compare counts and canonical per-type hashes after migration, including stable IDs/order/tool references/approvals/suppressions/evidence/cursors. Test unsupported schema, missing source database, disk-full, target collision and actual child kills at staging/verified/switching/active.
- [ ] Run tests; expect missing migration/version-2 reader behavior.
- [ ] Capture under the maintenance barrier, restore into an exclusive staging directory, stream versioned records into SQLite and rebuild derived indexes. Validate graph/integrity/hashes before switching a journaled manifest/selection. Preserve both source stores. In-place migration retains permission audit/definitions without replaying pending actions; recovery onto a new workspace resets active grants as in stage one. Source administrative credentials never initialize an unrelated target. Recovery never selects partial data. Retain stage-one legacy archive support and inactive permissions/schedules on recovery.
- [ ] Run migration/restore/crash/archive tests with source PostgreSQL disconnected after capture; expect Docker-independent recovery and unchanged originals. Commit `feat: migrate legacy workspaces into SQLite`.

## Task 7: Desktop workspace setup, movement and default gating

**Files:** Modify workspace-backend/window/main/recovery, native storage contracts/settings, local environment setup, Docker startup selection and build/package configuration; create workspace-move service/tests.

**Interfaces:** Native `previewMigration()/migrate(id)`, `openWorkspaceFolder()`, `chooseWorkspaceMove()/moveWorkspace(id)` use native paths and opaque handles. Move closes the owned backend, copies and verifies into exclusive staging, switches selection atomically and retains the old directory. A `sqliteDefaultVerified` build/runtime capability remains false until task 8 evidence is accepted; explicit tested SQLite workspaces can open before that gate.

- [ ] Test missing selected roots never create an empty database, newly selected SQLite workspaces never call Docker/PostgreSQL, external legacy attachments keep their engine, path aliases cannot own the same database twice, and a move failure preserves the prior selection. Assert portable moved roots preserve manifest identity while machine permissions require setup.
- [ ] Run tests; expect missing movement/unified setup behaviors.
- [ ] Connect normal/portable resolver, migration/move controls and recovery. Display actual data location and migration coverage. Updates replace application files only. Retain existing legacy startup until explicitly migrated. Do not advertise native Windows/Linux acceptance from path tests.
- [ ] Run native-controller/backend/build tests; expect packaged worker resolution and selection recovery. Commit `feat: manage durable desktop workspaces`.

## Task 8: Matched chat/voice and recovery acceptance

**Files:** Add benchmark script/fixtures and benchmark validation tests; update storage-verification/desktop/LOCAL-AI/MEMORY docs. Enable the fresh-workspace default only if all local migration/performance gates pass, retaining platform release gates.

**Interfaces:** Benchmark JSON records adapter, machine/OS/runtime/storage, corpus counts, fixed settings fingerprint, warmup/sample/process count, foreground/background case and p50/p95 for recall/context/persistence/first-text/first-persisted-voice-text/software-playback/event-loop delay/cancellation. Validator rejects unmatched settings or insufficient samples and exits nonzero on the exact budgets in Global Constraints.

- [ ] Write validator tests with insufficient corpora/samples, changed model/voice settings, timing regressions and false hardware-audio claims; expect failures before implementation.
- [ ] Build deterministic inference/file-audio fixtures exercising actual runner/voice persistence paths. Seed the reference workload and run at least 100 warm turns per case in two independent processes for each adapter, including scheduled snapshot and maintenance load. Keep cold start separate.
- [ ] Run correctness plus source-disconnected recovery against SQLite. Record all measured gates, including failures; optimize only evidence-backed bottlenecks and rerun affected comparisons. No timeout inflation or weakened durability.
- [ ] Run the whole suite/type/lint/format/production/desktop builds and fresh whole-stage review. Enable new-workspace SQLite default only with passing evidence; otherwise retain opt-in and report the exact unmet gate while continuing fixes. Commit `feat: enable verified Docker-free core workspaces` only when true.

Individual Dot transfer follows in stage three. Native package/audio/keyring acceptance for macOS/Windows/Linux remains stage four; neither is silently treated as complete by this plan.
