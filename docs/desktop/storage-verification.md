# Storage implementation verification

## Progress: 2026-10-20

The encrypted archive codec, runtime writer coordination, legacy capture API, and staged restore service are implemented. Native desktop backup/restore controls, trusted IPC, OS-protected password integration, and a separate archive/restore worker are connected. Live automatic scheduling is still pending. This is not a release-ready backup feature or a Docker-free storage migration. The approved [design](storage-portability-design.md) and [stage-one plan](storage-plan-01-backup-recovery.md) remain the acceptance criteria.

Core conversations and memory evidence still use PostgreSQL. No production database, Docker volume, or selected user workspace has been migrated or restored.

## Implemented behavior

- Authenticated age-encrypted streaming archives with bounded manifests, paths, sizes, and decompression; exact hashes; complete authentication before success; exclusive private staging and failure cleanup. An independent upstream age fixture checks interoperability.
- Admission covers local streamed turns and final receipts, scheduled work, local and remote voice lifetimes, detached memory jobs, setup telemetry, routes, and page SDK operations that outlive response timeouts. Automatic capture cancellation drains readers before admitting new foreground work, including blocked PostgreSQL reads.
- Owner-token snapshot operations capture SQLite with its online backup API and scoped PostgreSQL records under a repeatable-read transaction. Unsupported/remote storage and ambiguous cross-workspace references fail. Computer files and browser profiles are explicitly excluded.
- Restore validates SQLite schema/integrity and PostgreSQL record schemas/references into an exclusively created directory and newly created database. Archived SQL and environment configuration are never executed. File and database seals are checked again before activation; previews expire after 15 minutes.
- Restore pauses schedules and learning, cancels queued/running maintenance jobs, interrupts active operations, and requires fresh external access. Original permission and operation records remain in inert recovery audit data, including a core SQLite audit table carried by subsequent backups.
- Atomic workspace selection and a durable restore journal retain the old workspace. Desktop startup reconciles interrupted switches before opening stores. Replacement requires a host-verified pre-restore backup.
- Desktop storage settings and recovery-screen controls choose paths through native dialogs and clear password inputs immediately. The worker independently reads and verifies each encrypted archive before reporting success. Startup restore reconciliation also runs in the worker.
- OS-protected password integration rejects unavailable or insecure Linux storage. Daily/weekly retention policy is tested; live automatic scheduling remains pending.

## Verification evidence

Environment: macOS, Node 24.20.0, isolated worktree based on `20d3285`. PostgreSQL integration tests use only disposable `dots-storage-backup-test-9a43` on port 55439; the production PostgreSQL service on port 5434 is not used.

| Check                                                             | Result                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Vitest suite after native-controller integration             | 1,291 passed; one optional skipped; no failures                                                                                                                         |
| Real PostgreSQL capture                                           | WAL, ownership, reference validation, blocked-read cancellation, config change, disk-write failure and source usability tested                                          |
| Restore crash recovery                                            | Child process killed at staging, verified, switching and active journal boundaries; original or verified new selection retained                                         |
| Restore failure handling                                          | Missing references, unknown SQLite trigger, changed target files/database, expired preview, missing database-creation permission, and final journal disk failure tested |
| Typecheck, lint, formatting                                       | Passed                                                                                                                                                                  |
| Production desktop build                                          | Passed on macOS; existing large-renderer-chunk warning                                                                                                                  |
| Packaged archive worker                                           | Passed from an isolated directory without source/module lookup; encrypted round trip and cancellation cleanup verified                                                  |
| Native controller recovery                                        | Real authenticated capture, encrypted worker verification and restore into a new workspace passed; source preserved                                                     |
| Native graphical/process smoke                                    | Blocked before application startup: even bare Electron `--version` exits with SIGABRT in this execution environment                                                     |
| Native Windows/Linux, real OS keyrings and chat/voice performance | Not yet verified                                                                                                                                                        |

The suite uses the installed Python interpreter for the real npm/Python protocol fixture, avoiding a network-dependent `uv` environment resolution:

```sh
LOCAL_TEST_DATABASE_URL=postgres://postgres:disposable-test@127.0.0.1:55439/dots_storage_test \
MYOWN_LLM_PYTHON="$PWD/node_modules/myown-llm-integrator/python/.venv/bin/python" npm test
```

No test timeout was relaxed. The database URL above is disposable test infrastructure only.

## Dependencies and review

The owner installed pinned `age-encryption@0.3.1` and `tar-stream@3.2.2`. Their audit update introduced mixed CopilotKit versions; the owner subsequently aligned core, react-core and runtime to 1.75.0. Other compatible audit updates were retained. The execution shell cannot reach npm's audit endpoint, so there is no clean-security-audit claim.

Independent reviews of the foundations and runtime integration found writer wakeup, scheduler initialization, page timeout lifetime, archive cancellation and telemetry shutdown issues. Regression tests reproduced and resolved them. A full stage review remains required after native integration.

## Remaining release gates

1. Live automatic daily backups and managed retention. Native controls/worker/IPC are implemented and integration-tested; graphical and real OS keyring acceptance remains pending.
2. Recovery acceptance with original databases disconnected; native UI and OS credential-store checks.
3. Unified SQLite storage/migration, Dot export/import, portable workspace placement, and matched typed/voice performance measurements.
4. macOS, Windows and Linux package/runtime acceptance. A macOS build does not establish support on another OS.

Archive publication currently uses an exclusive same-filesystem hard link to avoid overwriting an existing destination. Filesystems without hard-link support fail safely; this portability limitation must be resolved before release. Core-only coverage excludes optional computer volumes and provider/OS credentials.
