# Dot storage durability and portability

Date: 2026-10-19

Approved design, 2026-10-19. Core Dot data will live in an app-managed workspace, survive Docker cleanup, and support verified workspace recovery and individual Dot transfer. Typed and voice chat must retain their current persistence guarantees and pass measured latency checks before the storage migration becomes the default.

## Requirements and scope

The owner approved consolidating core storage in SQLite, automatic workspace backups, and Dot export/import. The owner additionally requires macOS, Windows, and Linux support, asks for workspace placement alongside the installation, and wants to preserve chat and voice performance.

The approved location design supports ordinary OS installations and a portable folder containing the application and workspace. Portable distributions create their workspace beside the application; ordinary installer packages use the platform data directory. Existing workspace selections always take precedence over a new-install default. The portable folder satisfies installation-relative placement without writing inside executable bundles or protected system directories.

Deliver the work in separately verifiable stages: protect the current stores, migrate core storage, add individual Dot transfer, and validate native distributions on each OS. Cross-platform storage compatibility is required throughout; a working macOS build does not establish Windows or Linux runtime support.

Cloud synchronization, multi-user hosting, native Windows/Linux window-climbing observers, and copying installed AI providers or speech models are outside this storage design. Basic workspace and voice operation on each OS remain acceptance requirements for its release; unavailable optional window observation must degrade to floor-only companion behavior.

## Current implementation

The Electron host starts a bundled backend, but `CONVERSATION_BACKEND=local` still selects `PostgresConversations`. The default PostgreSQL service mounts a Docker named volume. SQLite holds Dots, Spaces, pages, settings, schedules, approvals, voice settings, curated memories, revisions, suppressions, and change receipts. PostgreSQL holds canonical conversations, run events/evidence, recall indexes, Compact checkpoints, and Dream job state. Optional Dot computers have separate files and browser-profile volumes.

The current app has memory-change restoration, but no complete backup/restore or per-Dot export/import. Its startup, build, and packaging scripts explicitly require macOS. Companion preferences and Chromium state are separate from workspace content.

The source boundaries are [workspace storage](../../src/server/workspace.ts), [conversation storage](../../src/server/local-conversations.ts), [memory jobs](../../src/server/memory-jobs.ts), [desktop backend ownership](../../src/desktop/host/workspace-backend.ts), and [desktop packaging](../../scripts/package-desktop.mjs).

## Storage decision

Use one authoritative SQLite database for core workspace state and a workspace-managed files directory. Retain a legacy PostgreSQL adapter for migration and rollback compatibility, not as a requirement for newly created local workspaces. Docker remains available for optional computer execution.

Keeping PostgreSQL with coordinated backups is the lowest-risk first stage. A host bind mount reduces Docker-volume deletion exposure but retains operational dependencies. Bundling a native PostgreSQL server avoids Docker while adding server lifecycle and upgrade work on every OS. Consolidated SQLite best matches the existing single-owner, one-backend-per-workspace model.

The workspace contains:

```text
workspace/
  workspace.json          # stable workspace ID and format version
  data/opendots.sqlite    # all authoritative core records
  files/                  # explicitly managed user artifacts
  recovery/               # migration and restore journals
```

Keep executable code, Python environments, downloaded models, disposable caches, and backup archives outside this tree. Existing configuration remains usable during migration; portable Dot archives never include host runtime configuration or credentials. Workspace identity becomes a persisted UUID rather than depending on the directory's spelling. Runtime exclusion still uses the canonical database location to prevent concurrent owners through path aliases.

Retain all canonical records, including source provenance, stable message/tool/run IDs, revisions, rejection/forget suppressions, processed-evidence receipts, and audit history. Search indexes and process caches are derived and rebuildable. A memory without its required source is explicitly unavailable; import must not invent evidence or grant broader access.

Optional computer storage is not silently classified as temporary. Backup status lists each configured computer volume and whether its files/profile are covered. Stage one can include consistent, quiesced volume snapshots when Docker is available. Durable output files can subsequently be promoted into workspace-managed files. An archive omitting computer data is visibly a core-only backup. Browser profiles are excluded from shareable Dot archives.

## Workspace placement across operating systems

For normal installations, resolve a writable per-user data directory using platform APIs and XDG conventions. Preserve the existing macOS location and any explicitly selected workspace.

| OS      | New normal-install workspace                                                                   |
| ------- | ---------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/My Own Dots Desktop/workspace`                                  |
| Windows | `%LOCALAPPDATA%\My Own Dots\workspace`                                                         |
| Linux   | `$XDG_DATA_HOME/my-own-dots/workspace`, falling back to `~/.local/share/my-own-dots/workspace` |

Windows uses local rather than roaming storage for the database. Keep Electron's profile/preferences separate from core content, and expose **Open workspace folder**, **Move workspace**, and the resolved location in Settings.

Portable distributions use an explicitly selected writable root:

```text
My Own Dots/
  application files       # .app bundle, Windows build, or Linux build
  portable.json           # versioned, relative workspace/profile paths
  workspace/
  desktop-profile/
```

On macOS, `workspace` is beside the `.app`, never inside it. On Windows, it is beside the application in a user-writable folder, not assumed writable under Program Files. On Linux, it is outside any read-only AppImage mount or system package directory. Derive the root from the explicit launcher/portable marker and actual application location, never the process working directory. Use a stable root outside versioned updater directories.

Application updates replace program files only. Moving the whole portable root while the app is closed preserves workspace identity and relative references. A different OS needs its own executable and integration runtimes; the workspace/archive format is shared. Credentials, microphone permission, executable paths, and external folder grants require destination-machine setup.

If the selected root is missing, read-only, or incompatible with local database locking, show recovery with the actual path and allow selection of another location. Never silently create a fresh empty workspace. Moving a workspace stops its backend, copies to a staged destination, verifies it, switches the recorded location, and retains the old copy until explicit removal. Direct concurrent access from network shares and live file-sync folders is unsupported; synchronize completed backup archives instead.

## Repository boundaries and concurrency

Introduce typed storage interfaces for conversations, memory evidence/checkpoints/jobs, and workspace records. Replace PostgreSQL-specific JSON/search/locking operations behind those interfaces. Preserve the existing HTTP and voice contracts, adapting internal consumers to asynchronous storage where necessary.

A dedicated backend storage worker owns the unified database and services bounded requests. Route database writes through one coordinator with foreground chat priority. This includes converting existing synchronous workspace mutation paths; adding a worker only for the new tables would still allow long synchronous lock waits on the backend event loop. Read-heavy work may use bounded read-only connections in separate workers; it cannot hold a write transaction or bypass permission checks.

Use WAL, foreign-key enforcement, explicit migrations, and `synchronous=FULL` for authoritative writes. Model inference, tool execution, network requests, and speech synthesis never run inside a database transaction. A thread lease uses atomic ownership acquisition, a fencing generation, and bounded expiry/recovery. A stale or cancelled worker cannot append events or publish Dream changes. Preserve one backend owner per workspace and concurrent independent threads.

Store event/message entries incrementally with indexed owner/thread/run/sequence keys; avoid rewriting an ever-growing event array on every streamed segment. Keep reconstruction and pending tool-call behavior compatible with existing conversation snapshots. Replace PostgreSQL full-text search with SQLite FTS5 and verify scope filters and retrieval behavior explicitly; ranking equivalence is not assumed.

Dream publication, its receipt, and processed-evidence acknowledgement can commit in one transaction after consolidation. Restart recovery must preserve existing receipt idempotency. Imported or restored active operations become interrupted or paused, never automatically replayed external actions.

## Typed and voice chat performance

Storage affects latency because [the runner](../../src/server/local-runner.ts) commits events before forwarding them, and [voice delivery](../../src/server/local-voice/context.ts) starts synthesis only for validated, persisted text. Preserve this ordering. A faster response must never come from speaking or displaying unsaved output.

SQLite removes the local database service connection but does not guarantee faster chat. Its single writer requires short transactions and predictable scheduling. The existing voice measurements include provider/model, recognition, and synthesis delays that changing storage does not eliminate.

Protect latency by keeping database work, archive compression, encryption, hashing, and large migrations outside Electron's main/renderer threads and the backend voice event loop. Background indexing and Dream yield between bounded batches when foreground work arrives. Automatic backups start when chat and voice are idle; once started, their bounded snapshot work yields or cancels for foreground activity. Compress an immutable snapshot outside the database worker. Migration, restore, and workspace moves are explicit maintenance operations with chat stopped.

Before changing the default, capture matched PostgreSQL and SQLite results on the same machine and dataset using deterministic inference and fixed/file audio. Preserve model, prompt, context, voice, and provider-session settings. Separate cold startup from warm turns. Record p50/p95 for context/recall, durable event writes, first visible text, first persisted voice text, first software playback acknowledgement, event-loop delay, and interruption/cancellation. Hardware listening is a separate native acceptance check; a playback acknowledgement is not an audible-onset measurement.

Acceptance budgets are design targets, not measured results:

| Check                                     | Release gate                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reference corpus                          | At least 10,000 memories and 100,000 messages over 100 threads, including a 1,000-message active conversation |
| Recall and context                        | p95 at most 100 ms and 200 ms respectively, preserving the existing benchmark targets                         |
| Foreground persistence                    | p95 event-write acknowledgement at most 25 ms on the reference local SSD, with no seconds-long lock waits     |
| Typed first text and voice first playback | No increase above the matched baseline greater than the larger of 5% or 50 ms at p50 or p95                   |
| Background interference                   | Meet the same foreground gates with a scheduled backup and maintenance workload; defer that work if needed    |
| Correctness                               | No lost/duplicated events, speech before commit, stale post-cancellation audio, or replayed side effects      |

Run at least 100 measured warm turns per case after warmup and repeat in independent processes. Report the device, storage, OS, runtime, workload, and sample count. Slow removable storage gets its own results; portable placement cannot guarantee internal-SSD latency. Cross-platform path tests alone do not satisfy native performance acceptance.

## Workspace backup and recovery

Provide **Back up now**, automatic daily backups after changes, and pre-migration/pre-restore snapshots. Default retention is seven daily and four weekly successful archives. Retention never deletes the only verified backup or user-managed exports. Show last attempt, last success, destination, included data, and errors separately. If the destination is unavailable or full, retain existing backups and report the failure without blocking chat or claiming success.

Place backups outside the active workspace. Offer a user-selected external destination; a second folder on the same disk protects against accidental deletion but not disk failure. Require a writable destination and enough staging space before starting.

For the current split stores, maintenance mode drains active work and pauses all writers before taking a SQLite backup plus a consistent PostgreSQL export. Record owner/workspace identity, formats, counts, included components, and checksums in one manifest. Release maintenance mode only after both snapshots represent that quiescent state. An automatic backup encountering a new foreground request cancels its incomplete snapshot pair and releases the barrier before admitting the request; the next idle period retries. Manual backup explains its maintenance pause. Optional computer snapshots require their own quiescence and explicit coverage reporting.

For the unified database, use the database's supported snapshot API. Do not copy only the live `.sqlite` file while ignoring its WAL. Workspace-managed files are immutable once referenced or protected by the same snapshot barrier, so database references and file contents agree.

Full recovery archives can contain private transcripts, connection tokens, and configuration secrets already stored in the workspace. Encrypt them with a reviewed authenticated archive format and a recovery password; keep scheduled-backup key material in the OS credential store, not beside the archive. The user must retain the recovery password for another machine. Provider CLI profiles and OS credentials are not copied. Portable Dot exports are separately sanitized and may be password protected.

Restore validates integrity, compatibility, archive bounds, database consistency, and referenced files in a temporary workspace. Show a preview of the recovery point and coverage. Restore into a new workspace by default. Replacement requires a fresh verified pre-restore backup, exclusive ownership, and a recoverable switch journal. Close database handles before switching; retain the previous directory, especially on Windows where open-file replacement behaves differently. Failure leaves the existing workspace selected and usable.

Restore retains permission and connection audit history but does not automatically activate external access or schedules. Reapprove folder/computer access and reconnect integrations on a new machine; reselect host executable paths rather than applying those from an archive. Backend and PostgreSQL administrative credentials from the backup are never used to overwrite unrelated destination configuration.

## Migration from the existing databases

1. Resolve the selected workspace and configured PostgreSQL database; do not infer a different database from a listening port or create an empty replacement when the source is unavailable.
2. Check schema versions, free space, ownership, and backup destination. Complete a verified backup before changing active storage.
3. Quiesce the existing backend and its maintenance/scheduled writers. Copy into a new SQLite database under a staging directory; leave both sources unchanged.
4. Preserve IDs, owner identity, messages, run order, tool references, approvals, revisions, suppressions, evidence, and learning cursors. Rebuild derived indexes without changing the retained canonical records.
5. Compare record counts and canonical content hashes by table/type, validate all relationships, and run chat/recall/recovery checks against the staged database. No real inference or tool action is needed for validation.
6. Atomically update the workspace selection/manifest only after validation. Record a completed migration journal and restart with SQLite. An interrupted migration resumes or discards staging safely, never partially selecting it.
7. Retain PostgreSQL volumes and the original SQLite store. Never delete them as part of migration. A later rollback after new SQLite writes restores a chosen recovery point or explicitly exports those newer records; switching to stale PostgreSQL is not lossless rollback.

Fresh workspaces skip PostgreSQL setup. Legacy and externally attached workspaces keep their selected backend until explicitly migrated. The authenticated workspace identity and ownership checks continue to prevent attaching to a different workspace.

## Individual Dot transfer

Use a versioned `.dotpack` archive with a manifest, canonical structured records, selected managed files, component checksums, and minimum reader version. It is a logical export, not a dump of the entire workspace database.

Export offers the Dot's identity/instructions, voice/personality and learning settings, private curated memory/history, and optional conversation history. Shared owner/Space memories and pages are shown for explicit inclusion. Include source evidence and suppression dependencies for each selected memory; if a dependency is omitted, mark that memory unavailable for automatic recall on import rather than broadening access. Show a content/coverage preview before saving.

Do not include credentials, provider sessions, browser profiles, external-folder access grants, computer permissions, or executable configuration. External folder contents are included only when the user explicitly selects files to copy. Schedules and integrations may be included as definitions but import disabled and disconnected.

Import defaults to **Create a new Dot**. Map owner, Dot, Space, page, conversation, run, and source identifiers consistently, including references inside serialized payloads. Preserve message/tool identity relationships, suppression semantics, and provenance. Do not merge into an existing Dot in version one; complete workspace replacement belongs to backup/restore.

Validate and stage the entire import before committing. Reject path traversal, absolute archive paths, symlink escapes, platform-reserved names, case collisions, excessive entry counts/uncompressed sizes, incompatible schemas, and checksum failures. Use the same bounded validation on all OSes. Imported active runs and jobs are interrupted, schedules paused, connections disconnected, and folder grants absent. Repeated imports create explicitly separate Dots instead of silently duplicating records inside one Dot.

## Cross-platform release boundary

Separate workspace startup from the macOS Swift observer. Windows/Linux must be able to open the workspace and start its owned backend without that helper. Use capability adapters for optional companion geometry, permissions, dialogs, shortcuts, process spawning/termination, and audio. Provide floor-only companion behavior where no observer exists.

Build and exercise native packages on macOS, Windows, and Linux. Verify bundled Node/SQLite support, provider executable resolution, Python/speech dependency compatibility, subprocess cancellation, microphone permissions, and shutdown. Availability of an Electron package is not evidence that each external AI CLI or voice stack works on that OS. Readiness reports the missing integration clearly while retaining access to stored data and backup/export controls.

The acceptance matrix includes normal and portable locations; Unicode/spaces/case differences; denied writes; read-only distributions; root relocation; app upgrade and reinstall with data retained; missing removable drives; simultaneous opens; database-worker crash; interrupted migration/restore; archive corruption; and cross-OS export/import in both directions. Full native voice support remains gated until exercised on that OS.

## Delivery and verification

Stage 1 delivers coordinated backup/restore for existing stores, coverage reporting, and fresh-workspace recovery tests. Stage 2 delivers the unified storage worker/interfaces, migration, workspace placement, and matched chat/voice benchmarks. Stage 3 delivers per-Dot archives and isolation/provenance/import tests. Stage 4 completes native packaging and acceptance on each OS; its platform adapters can be prepared earlier without claiming release readiness.

Use disposable databases and temporary workspaces for automated verification. Preserve current production data and the owner's unrelated work. Release evidence must distinguish implemented code, deterministic tests, hardware/platform checks, and measured performance.

## References

- [Existing storage and recovery behavior](../MEMORY.md#storage-and-recovery)
- [Existing voice timing boundaries](local-voice-calls.md#per-turn-latency-trace)
- [Electron application paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
- [Apple application file placement](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPFileSystem/Articles/WhereToPutFiles.html)
- [Microsoft standard-user file access](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/user-account-control-for-game-developers#file-access-as-a-standard-user)
- [SQLite WAL concurrency](https://www.sqlite.org/wal.html)
- [SQLite consistent backups](https://www.sqlite.org/backup.html)
