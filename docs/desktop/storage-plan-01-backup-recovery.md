# Workspace Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the existing SQLite/PostgreSQL workspace from encrypted, verified backups without modifying its original stores.

**Architecture:** A backend maintenance barrier produces consistent staged snapshots. A native host coordinator chooses destinations and runs archive/encryption work in a utility worker; restore validates into a new workspace before switching selection.

**Tech Stack:** Node 24 SQLite backup API, existing `pg`, TypeScript/Zod/Vitest, Electron native dialogs and safeStorage, `age-encryption@0.3.1`, `tar-stream@3.2.2`, Node streams/zlib.

**Spec:** [Approved design](storage-portability-design.md), especially workspace backup and recovery; [global constraints](storage-implementation-plan.md#global-constraints) apply to every task.

## Global Constraints

- Automatic daily backups run after changes while idle; retain seven daily and four weekly successful archives.
- Never delete the only verified backup, user-managed exports, source databases, or Docker volumes.
- Drain all app writers for a split-store snapshot; a new foreground request cancels an incomplete automatic snapshot pair before work resumes.
- Full backups are encrypted; key material is OS-protected outside archives. Unavailable secure storage disables unattended backups, not manual password-based recovery.
- Restore pauses schedules, interrupts active runs, and requires fresh external-access approval.
- Host-selected paths and secrets are not model tools or arbitrary renderer-supplied filesystem paths.

## Review Focus

- A tool completion races with snapshot acquisition: task 2 must drain its final durable writes.
- Another workspace shares the PostgreSQL server/owner: task 3 must scope rows or reject ambiguity.
- An archive is corrupt, truncated, huge, or has Windows/path aliases: task 1 rejects it before any destination activation.
- A process dies at each restore boundary: task 4 must recover the old or fully verified new selection.
- Linux has no keyring or a backup disk vanishes: tasks 5–6 report failure without plaintext secrets or false success.

## File boundaries

Create `src/shared/storage-archive.ts` for manifests, `src/server/storage/archive.ts` for streaming archive validation, `maintenance.ts` for writer exclusion, `legacy-snapshot.ts` for current-store capture, and `restore.ts` for staged recovery. Native orchestration lives in `src/desktop/host/storage-controller.ts`, `backup-keys.ts`, `backup-schedule.ts`, and a new `src/desktop/shared/storage-contract.ts`; UI lives in `src/client/StorageSettings.tsx`.

## Task 1: Versioned encrypted archives

**Files:** Create the shared manifest and `src/server/storage/{archive,archive-paths}.ts`; create `tests/storage/{archive,archive-paths}.test.ts` and `tests/fixtures/storage-archive.ts`; modify `package.json` and `package-lock.json`.

**Interfaces:** Define `ArchiveKind = 'workspace-backup' | 'dot-export'`; `ArchiveEntry = { path: string; bytes: number; sha256: string }`; `ArchiveManifest = { version: 1; minimumReader: 1; kind: ArchiveKind; archiveId: string; workspaceId: string; ownerId: string; createdAt: string; entries: ArchiveEntry[]; coverage: { component: string; state: 'included' | 'excluded' | 'unavailable'; reason?: string }[] }`. Export `writeArchive({ sourceDirectory, manifest, destination, passphrase, signal }): Promise<void>` and `readArchive({ source, stagingDirectory, passphrase, signal }): Promise<ArchiveManifest>`; paths are strings and signal is `AbortSignal`, passphrase is required for backups and optional for Dot archives. Both return only after full validation/finalization.

- [ ] Write failing tests named `rejects truncated age output without publishing files`, `rejects portable path aliases`, and `round trips a large stream with bounded buffering` using a temp-directory fixture; assert `await expect(readArchive(corrupt)).rejects.toThrow()`, zero activated files, and exact original hashes after valid round trip.
- [ ] Run `npm test -- tests/storage/archive.test.ts tests/storage/archive-paths.test.ts`; expect failures for missing interfaces.
- [ ] Implement age-encrypted gzip/tar streaming, not custom cryptography. Pin the reviewed library versions above after checking registry availability/integrity; stop for dependency review if unavailable. Manifest is first and limited to 4 MiB; maximum 100,000 entries, 64 GiB total expanded content, 16 GiB/file, and 1,024 UTF-8 bytes/path. Reject links/devices, absolute/traversal paths, duplicate normalized/case-insensitive paths, trailing dot/space aliases, reserved Windows names, unexpected entries, and mismatched sizes/hashes. Use exclusive private staging, stream backpressure, authenticated EOF, and publish via same-directory rename only after validation. Tests use smaller injected quotas to exercise boundaries cheaply.
- [ ] Run both test files and `npm run typecheck`; expect pass, including empty archives, wrong passwords, cancellation, Unicode paths, and quota boundaries. Add an age upstream-format fixture so round-trip alone does not prove interoperability.
- [ ] Commit only task files: `git commit -m "feat: add verified workspace archives"` after explicitly staging them.

## Task 2: Drain and exclude all workspace writers

**Files:** Create `src/server/storage/maintenance.ts`, `tests/storage/maintenance.test.ts`; modify `src/server/{app,index,platform,runner,local-runner,memory-maintenance}.ts`, `src/server/local-voice/{routes,service}.ts`.

**Interfaces:** Export `MaintenanceGate.enterWrite(signal: AbortSignal): Promise<() => void>`, `acquire({ origin: 'manual' | 'automatic', signal }): Promise<{ signal: AbortSignal; release(): void }>`, and `status(): { held: boolean; activeWrites: number }`. A release function is idempotent. Gate cancellation waits until snapshot readers release before admitting the foreground writer. Manual acquisition fails with a clear busy result if a call/turn is active; automatic acquisition waits for idle and yields to new foreground activity.

- [ ] Write `waits for tool result and workspace receipt before snapshot`, `automatic snapshot yields before new run`, and `manual snapshot refuses active voice`: hold two writer leases, assert acquisition is pending until both release; assert a foreground write begins only after cancelled snapshot cleanup.
- [ ] Run `npm test -- tests/storage/maintenance.test.ts`; expect missing gate failures.
- [ ] Wrap whole mutation lifetimes, not just HTTP response creation: AG-UI streamed turns, scheduled tasks, Dream/Compact publication, voice call/delivery/transcript writes, setup telemetry, and ordinary mutation routes. Avoid nested deadlocks by passing an existing operation context through nested writes. Keep identity/status/cancel endpoints available. Shutdown permanently closes admission; backup release resumes it. Do not use existing permanent `stop()` methods as a resumable pause.
- [ ] Run the new tests plus `npm test -- tests/local-runner.test.ts tests/shutdown.test.ts tests/voice-stream-runner.test.ts`; expect unchanged durable-output ordering and no leaked barrier after errors.
- [ ] Stage task files and commit `feat: coordinate workspace snapshots`.

## Task 3: Capture the selected legacy workspace

**Files:** Create `src/server/storage/{legacy-snapshot,postgres-records,snapshot-routes}.ts`, `tests/storage/legacy-snapshot.test.ts`, `tests/fixtures/storage-workspace.ts`; modify `src/server/{app,index}.ts`.

**Interfaces:** `SnapshotSource.capture(directory: string, signal: AbortSignal): Promise<ArchiveManifest>` and `LegacySnapshotSource({ sqlitePath, postgresUrl, ownerId, workspaceId, gate })` implement this boundary. Expose authenticated `/api/storage/snapshots` create/status/cancel/release endpoints using opaque operation IDs and app-owned staging paths; the client cannot supply server filesystem paths. Task 1's manifest carries component coverage.

- [ ] Seed two owners and two Dot sets with messages, voice receipts, approved/forgotten memories, jobs, pages, pending approvals, and a SQLite WAL write. Test `snapshot contains final committed rows from both stores`, asserting captured IDs/hashes equal the selected fixture and do not contain the other workspace's sentinel. Test missing PostgreSQL rejects full success.
- [ ] Run `npm test -- tests/storage/legacy-snapshot.test.ts` with dedicated `LOCAL_TEST_DATABASE_URL`; expect missing snapshot implementation failures, not skipped integration tests.
- [ ] Under task 2's barrier use `node:sqlite.backup` and a PostgreSQL repeatable-read transaction. Stream allowlisted tables as versioned JSONL with explicit timestamp/bigint encoding; scope by selected owner and Dot/thread graph from SQLite, reject ambiguous cross-workspace references, and rebuild owner-wide derived indexes later. No raw SQL dump execution on restore. Include encrypted configuration evidence for recovery, but mark host secrets/runtime paths as non-activatable. Inventory configured computer volumes and report exclusions explicitly; this stage's guaranteed archive is core-only. Never report complete computer coverage without verified quiescence/snapshot support.
- [ ] Run integration tests including cancellation between the two stores, failed disk writes, changed source config, WAL capture, and unsupported external attachment; expect no published partial archive and continued source usability.
- [ ] Stage task files and commit `feat: snapshot existing Dot workspaces`.

## Task 4: Stage, verify, and activate a restore

**Files:** Create `src/server/storage/{restore,restore-journal,restore-postgres}.ts`, `tests/storage/restore.test.ts`; modify `src/desktop/host/workspace-backend.ts` and task 3's snapshot interfaces as needed for quiescence.

**Interfaces:** `prepareRestore({ archive, passphrase, destination, postgresTarget?, signal }): Promise<RestorePreview>`; `RestorePreview = { operationId: string; workspaceId: string; counts: Record<string, number>; coverage: ArchiveManifest['coverage']; warnings: string[] }`. `activateRestore(operationId: string, mode: 'new' | 'replace', signal: AbortSignal): Promise<{ workspaceDirectory: string }>` consumes only a server-created, verified journal, rechecks target ownership, and expires previews after 15 minutes.

- [ ] Write `recovers selection after crash at each journal boundary`, `restores without replaying pending actions`, and `refuses restore over an unrelated database`; assert original sentinel survives every injected failure, restored counts/hashes match, schedules are paused, and no provider/tool callback runs.
- [ ] Run `npm test -- tests/storage/restore.test.ts`; expect missing interfaces to fail.
- [ ] Restore SQLite and scoped PostgreSQL JSONL into a new directory and newly created destination database; never clean/populate a pre-existing PostgreSQL database. Use a host-selected server/configuration, not archived administrative credentials. Journal `staging -> verified -> switching -> active`; close handles before switching, retain old directory, and atomically write the workspace selection. For replacement require a verified pre-restore backup. Reset active leases and external permissions while retaining their audit records. Recovery startup reconciles journals before opening stores. Lack of database-creation permission leaves original data intact with a usable error.
- [ ] Run task tests with process-kill fixtures, invalid schemas/checksums, expired preview, destination change, and failed activation. Confirm no raw archived `.env` is executed/applied and cleanup touches only operation-owned staging.
- [ ] Stage task files and commit `feat: restore verified workspace backups`.

## Task 5: Native backup controls and protected keys

**Files:** Create `src/desktop/{shared/storage-contract.ts,host/storage-controller.ts,host/backup-keys.ts,host/archive-worker.ts}`, `src/client/StorageSettings.tsx`, `tests/desktop/storage-controller.test.ts`, `tests/storage-settings.test.tsx`; modify `src/desktop/{workspace-preload.ts,host/workspace-window.ts}`, `src/client/{WorkspaceDialog.tsx,workspace-bridge.d.ts}`, `scripts/desktop-runtime.mjs`, and `scripts/build-desktop.mjs`.

**Interfaces:** `DesktopStorageBridge` exposes `status()`, `chooseBackupDirectory()`, `backupNow({ passphrase, remember })`, `previewRestore()` using a native open dialog, `restore({ operationId, mode })`, `cancel(operationId)`, and status subscription. Define `StorageOperationStatus = { id: string; kind: 'backup' | 'restore'; phase: 'queued' | 'snapshot' | 'archive' | 'verify' | 'ready' | 'failed' | 'cancelled'; error?: string }`. Return opaque handles and summaries, not secret-bearing configuration or write-capable arbitrary paths.

- [ ] Write tests `rejects untrusted or navigated IPC sender`, `cancelled chooser creates nothing`, and `Linux basic_text never remembers password`; assert rejected operations never call the filesystem/backend, and UI distinguishes snapshotting from verified success.
- [ ] Run `npm test -- tests/desktop/storage-controller.test.ts tests/storage-settings.test.tsx`; expect missing bridge/component failures.
- [ ] Follow existing trusted workspace IPC and focused native picker patterns. Run archive work in its own process/worker. Use Electron safeStorage for an encrypted password blob in the profile, with the wrapping key protected by the OS; reject `basic_text`, `unknown`, or unavailable encryption for remember/scheduling. Manual password-based backup remains available. Passwords are never logged, placed on command lines, persisted in renderer state, or copied into archives. Show destination, coverage exclusions, progress, last attempt/success, restore preview, and explicit replacement confirmation. Attached backends require supported maintenance capability; never stop an external process to obtain a snapshot.
- [ ] Run the task tests, `tests/desktop/workspace-window.test.ts`, `npm run typecheck`, and `npm run desktop:build`; expect packaged worker resolution and trusted bridge checks to pass.
- [ ] Stage task files and commit `feat: add native backup and restore controls`.

## Task 6: Automatic backups and recovery acceptance

**Files:** Create `src/desktop/host/backup-schedule.ts`, `tests/desktop/backup-schedule.test.ts`, `tests/storage/recovery-e2e.test.ts`, `docs/desktop/storage-verification.md`; modify storage settings/controller and `docs/{LOCAL-AI,MEMORY}.md`, `docs/desktop/README.md`.

**Interfaces:** `BackupSchedule.tick({ now: number, revision: string, idle: boolean }): Promise<void>` uses controller backup operations. `selectRetainedBackups(records: { id: string; createdAt: string; verified: boolean; managed: boolean }[]): Set<string>` returns IDs to retain; group daily/weekly buckets in UTC for stable behavior after timezone changes.

- [ ] Write `keeps seven daily and four weekly verified points`, `never prunes last verified or unmanaged export`, `skips unchanged state`, and `missing destination does not become success`. Assert exact retained IDs, one admission per changed UTC day, and successful retry after the drive returns. Add end-to-end `backup restores into an empty workspace with source disconnected` including memory suppression and pending tool approvals.
- [ ] Run `npm test -- tests/desktop/backup-schedule.test.ts tests/storage/recovery-e2e.test.ts`; expect scheduler/acceptance failures before implementation.
- [ ] Persist scheduler state outside source data so backup metadata does not endlessly count as content changes. Publish verified new archives before pruning only managed archives. Setup requires a user-chosen external-to-workspace destination and recovery password; show that same-disk copies do not protect against disk loss. Record core/computer coverage without promising omitted recovery.
- [ ] Run all `tests/storage`, new desktop/UI tests, and the repository gates in the overview. Record an actual disposable recovery with source databases unavailable. No benchmark or native-platform claim without its evidence.
- [ ] Stage task files and commit `feat: schedule verified workspace backups`.

## Dependency references

The proposed versions were inspected in the maintainers' sources, not installed during planning: [age-encryption manifest](https://github.com/FiloSottile/typage/blob/main/package.json), [streaming age API](https://github.com/FiloSottile/typage#encrypt-and-decrypt-using-the-streams-api), [tar-stream](https://github.com/mafintosh/tar-stream), [Electron secure storage](https://www.electronjs.org/docs/latest/api/safe-storage). Verify published release provenance and include licenses when adding them. These references do not substitute for the archive's security review and interoperability tests.
