# Storage implementation verification

## Progress: 2026-10-21

Workspace backup/restore, trusted native IPC, a separate archive worker, OS-protected password storage and opt-in automatic backups are connected. The owner-confirmed backup/restore tests have been followed by a simpler UI: native file selection, optional manual-backup encryption, and a single restore action. See the current [usage guide](README.md#workspace-backup-and-recovery) and [owner amendment](storage-portability-design.md#owner-amendment-simpler-backup-and-restore-2026-10-20).

Existing/default workspaces still use PostgreSQL until explicitly upgraded. The unified SQLite backend, desktop startup, movement and migration controls are connected; broader task-seven acceptance and task-eight performance/default gates remain unfinished. No actual user data was upgraded during the UI verification. Individual Dot transfer and native Windows/Linux release acceptance remain pending.

### Simplified UI verification (2026-10-20)

- 87 focused archive, controller, renderer, preload, window and real PostgreSQL integration tests passed, including both encrypted and unencrypted backup/restore through native-selected filenames. Manual archives survived scheduled retention.
- Final full suite: 1,441 passed across 182 files, one skipped, no failures. The earlier run hit the known intermittent `conversation-repositories.test.ts > recovers after SIGKILL with inflight event writes` startup-marker timeout; that test passed in the final run.
- Typecheck, lint and macOS desktop build passed. The existing large-renderer-chunk warning remains.
- Native macOS inspection confirmed the two primary actions, collapsed advanced options, save dialog on Backup, password protection off by default, optional password input, and file picker on Restore. Dialog cancellation returned to the main screen. No user backup was written or restored by these UI checks.
- Independent read-only review found no blocking issue. A regression test exposed and fixed stale manual success feedback masking later automatic-backup progress.
- Evidence logs are in `.superpowers/sdd/storage-plan-02-unified-workspace/simple-storage-*.log`. Native Windows/Linux and chat/voice performance acceptance remain unverified.

### PR verification and settings consistency (2026-10-21)

- Full suite: 1,442 passed across 182 files, one optional signing test skipped, no failures. The first run reproduced the crash-test startup race. Its fixture now reports initialization before the existing transaction-barrier wait; a 1.4-second injected startup delay also passed. No test timeout or durability assertion was relaxed.
- Independent review reproduced a moved-workspace attachment bug: the retained original could authenticate under the copied token and persistent workspace ID. The destination now receives a fresh backend token. A real move/launcher regression verifies rejection of the original, unchanged source configuration, preserved provider values, and successful attachment with the destination token. Review found no remaining blocker in that change.
- Settings uses compact rows, short descriptions and collapsed setup help, based on official [Linear preferences](https://linear.app/docs/account-preferences) and [Apple System Settings](https://support.apple.com/en-eg/guide/mac-help/mh15217/mac) references. The neutral light/dark palette is shared by all workspace views, preventing the navigation background from changing when opening Settings. Backup/Restore actions and optional password behavior remain covered by the existing tests.
- Typecheck, lint, repository formatting, production build and macOS desktop build passed. Native macOS inspection confirmed matching navigation backgrounds between Chats and Settings in both light and dark modes; the original dark preference was restored.
- Evidence: local `pr-full-suite-final.log`, `pr-crash-delayed-start.log`, `pr-move-token-red.log` and `pr-review-fixes.log` under `.superpowers/sdd/storage-plan-02-unified-workspace/`. The broader native/performance/default release gates below are unchanged.

## Implemented behavior

- Optional authenticated age encryption for manual streaming archives with bounded manifests, paths, sizes, and decompression; exact hashes; complete authentication before success; exclusive private staging and failure cleanup. An independent upstream age fixture checks interoperability.
- Admission covers local streamed turns and final receipts, scheduled work, local and remote voice lifetimes, detached memory jobs, setup telemetry, routes, and page SDK operations that outlive response timeouts. Automatic capture cancellation drains readers before admitting new foreground work, including blocked PostgreSQL reads.
- Owner-token snapshot operations capture SQLite with its online backup API and scoped PostgreSQL records under a repeatable-read transaction. Unsupported/remote storage and ambiguous cross-workspace references fail. Computer files and browser profiles are explicitly excluded.
- Restore validates SQLite schema/integrity and PostgreSQL record schemas/references into an exclusively created directory and newly created database. Archived SQL and environment configuration are never executed. File and database seals are checked again before activation; previews expire 15 minutes after verification completes, independent of preparation duration.
- Restore pauses schedules and learning, cancels queued/running maintenance jobs, interrupts active operations, and requires fresh external access. Original permission and operation records remain in inert recovery audit data, including a core SQLite audit table carried by subsequent backups.
- Atomic workspace selection and a durable restore journal retain the old workspace. Desktop startup reconciles interrupted switches before opening stores. Replacement requires a host-verified pre-restore backup.
- Desktop storage settings and recovery-screen controls choose paths through native dialogs and clear password inputs immediately. The worker independently reads and verifies each archive before reporting success. Startup restore reconciliation also runs in the worker.
- OS-protected password integration rejects unavailable or insecure Linux storage. Daily backups check for changes while idle, use an OS-protected password scoped to the workspace, and retain seven daily plus four weekly recovery points. Missing destinations preserve the last success and retry later. Retention runs after verified publication and preserves unrecognized/replaced files.

## Unified storage implementation

- Versioned workspace identities and normal/portable location resolution preserve explicit selections and reject missing selected roots. Native migration, SQLite startup and verified workspace movement are implemented; broader native acceptance remains pending. Movement retains the original, preserves workspace identity and assigns a fresh backend token so the selected copy cannot silently attach to the original's running backend.
- One worker owns the runtime SQLite handles. Typed async repositories serve chat, voice, pages, settings, permissions, scheduler, telemetry, recall, and Dream jobs. Existing PostgreSQL evidence remains available through the same runtime.
- SQLite conversations persist incremental events and immutable message versions under fenced thread leases. Evidence uses bounded indexing, FTS5, suppression and access checks; Dream publication commits its receipt, memory changes and source acknowledgments together.
- Runtime tests cover actual worker chat/page writes, delayed permission revocation, scheduled progress, telemetry, Dream publication/cancellation, and final voice receipts. A queued Dream cannot publish after shutdown cancellation. Backups wait for durable voice cleanup; the shutdown deadline includes scheduler draining.
- Production startup constructs core databases only in the storage worker. Offline capture/recovery retain their controlled database handles. A worker failure closes the backend.

- Version 2 archives describe one unified SQLite snapshot and restore without PostgreSQL. Version 1 legacy archives remain readable. Restoration validates schema, graph references, message hashes, source evidence and owner scope.
- Explicit legacy migration creates and independently verifies a backup, converts all canonical SQLite/PostgreSQL record classes into a separate SQLite workspace, and compares per-type counts and canonical hashes. Stable IDs, permission definitions, approval history, suppressions and processed-source evidence survive. Active operations are interrupted and automation pauses; the original stores remain intact.
- Activation rechecks the source, configuration, backup and prepared target under exclusive ownership. New source writes require a fresh preview. Native controls show the destination and verified backup, retain the preview while the backend is stopped, and reopen the original workspace after cancellation or preparation failure.
- Real child-process kills at staging, verified, switching and active boundaries preserve either the original selection or a complete verified workspace. Startup cleans owned, unchanged migration captures; unexpected files are retained with a recovery warning. Disk-full, destination collision, missing source, changed backup/configuration and changed SQLite/PostgreSQL source cases are covered. The isolated packaged worker completes migration through native quiesce acknowledgments.

## Verification evidence

Environment: macOS, Node 24.20.0, isolated worktree based on `20d3285`. PostgreSQL integration tests use only disposable `dots-storage-backup-test-9a43` on port 55439; the production PostgreSQL service on port 5434 is not used.

| Check                                                             | Result                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Vitest suite after migration/recovery integration            | 1,402 passed across 180 files; one optional skipped; no failures                                                                                                        |
| Real PostgreSQL capture                                           | WAL, ownership, reference validation, blocked-read cancellation, config change, disk-write failure and source usability tested                                          |
| Restore crash recovery                                            | Child process killed at staging, database creation, verified, switching and active journal boundaries; original or verified new selection retained                      |
| Restore failure handling                                          | Missing references, unknown SQLite trigger, changed target files/database, expired preview, missing database-creation permission, and final journal disk failure tested |
| Typecheck, lint, formatting                                       | Passed                                                                                                                                                                  |
| Production and desktop builds                                     | Passed on macOS; existing large-renderer-chunk warning                                                                                                                  |
| Packaged archive worker                                           | Passed from an isolated directory without source/module lookup; encrypted round trip and cancellation cleanup verified                                                  |
| Native controller recovery                                        | Real authenticated capture, encrypted worker verification and restore into a new workspace passed; source preserved                                                     |
| Native graphical/process smoke                                    | macOS workspace startup, settings and native backup/restore pickers inspected; this does not establish Windows/Linux support                                            |
| Native Windows/Linux, real OS keyrings and chat/voice performance | Not yet verified                                                                                                                                                        |

A separate recovery test closes all source handles, renames the original SQLite directory out of reach, and disables connections to its own disposable PostgreSQL source database. Recovery into an empty directory/new database succeeds with messages, forgotten-memory markers and suppressions intact; schedules stay paused and pending approvals are removed.

The minute scheduler uses bounded SQLite/WAL file metadata and PostgreSQL cumulative mutation counters, rather than scanning history or adding per-message writes. Counters can lag until a later tick; checkpoints and another workspace sharing the same tables can cause an extra daily backup. This is a conservative change signal, not a content hash. See [PostgreSQL's statistics semantics](https://www.postgresql.org/docs/17/monitoring-stats.html). No measured chat/voice performance claim follows from this design alone.

The suite uses the installed Python interpreter for the real npm/Python protocol fixture, avoiding a network-dependent `uv` environment resolution:

```sh
LOCAL_TEST_DATABASE_URL=postgres://postgres:disposable-test@127.0.0.1:55439/dots_storage_test \
MYOWN_LLM_PYTHON="$PWD/node_modules/myown-llm-integrator/python/.venv/bin/python" npm test
```

No test timeout was relaxed. The database URL above is disposable test infrastructure only.

## Dependencies and review

The owner installed pinned `age-encryption@0.3.1` and `tar-stream@3.2.2`. Their audit update introduced mixed CopilotKit versions; the owner subsequently aligned core, react-core and runtime to 1.75.0. Other compatible audit updates were retained. The execution shell cannot reach npm's audit endpoint, so there is no clean-security-audit claim.

Independent reviews of the foundations and runtime integration found writer wakeup, scheduler initialization, page timeout lifetime, archive cancellation and telemetry shutdown issues. Regression tests reproduced and resolved them. A fresh independent whole-stage review found two Important restore lifecycle issues and no Critical or Minor findings. Regression tests reproduced and fixed preview expiry during long preparation and leaked abandoned preparations. Cancellation/supersession/close discard unused previews; startup reclaims interrupted staging and abandoned verified preparations. Cleanup checks directory and database ownership and retains active or changed targets with a manual-cleanup notice. PostgreSQL targets gained a durable OID/identity marker before import, and an actual process-kill test covers this boundary. Two focused reruns hit timeouts: parallel crypto workers exceeded five seconds once, and a cold-start unit test saw an execution suspension of roughly 904 seconds. The serial focused checks and subsequent full suite passed unchanged; no existing timeout was increased.

## Remaining release gates

1. Remaining native runtime and real OS credential-store acceptance. macOS settings/picker inspection and independent backup-stage reviews are complete.
2. Automatic capture and restore are integration-tested, including source-disconnected recovery. Full native runtime acceptance remains pending.
3. Dot export/import, broader desktop workspace startup/placement/movement acceptance, and matched typed/voice performance measurements. Backend SQLite correctness is tested; performance/default activation remains gated.
4. macOS, Windows and Linux package/runtime acceptance. A macOS build does not establish support on another OS.

Archive publication currently uses an exclusive same-filesystem hard link to avoid overwriting an existing destination. Filesystems without hard-link support fail safely; this portability limitation must be resolved before release. Core-only coverage excludes optional computer volumes and provider/OS credentials.
