# Storage implementation verification

## Checkpoint: 2026-10-20

This is a partial implementation checkpoint, not a working backup/restore release. The approved [design](storage-portability-design.md) and [stage-one plan](storage-plan-01-backup-recovery.md) remain the acceptance criteria.

Implemented and unit tested in an isolated managed worktree:

- Version-one archive manifest parsing, identity/coverage validation, and hard size/count limits.
- Portable archive path validation, including traversal, reserved Windows names, case/Unicode aliases, and file/directory collisions.
- Maintenance admission primitive: active writes drain before capture; automatic snapshots yield to foreground work but retain exclusion until reader cleanup; nested writes drain; closed admission stays closed.
- Protected backup-password storage policy using an injected Electron safeStorage boundary. Linux `basic_text`, `unknown`, and unreviewed backends cannot remember passwords. Native keyring behavior is not yet verified.
- Persistent daily scheduling policy and UTC retention. Keep the newest successful archive for each of seven daily and four weekly buckets; overlapping buckets share an archive. Unmanaged, unverified, and invalid-metadata records are retained. Pruning starts only after verified success metadata is saved.

These helpers are not yet connected to runtime writers or desktop controls. Existing workspace databases, Docker volumes, workspace selections, and chat/voice behavior are unchanged. No migration or user-data recovery has been performed.

## Verification evidence

Environment: macOS, Node 24.20.0, isolated worktree based on `20d3285`.

| Check                                                        | Result                                           |
| ------------------------------------------------------------ | ------------------------------------------------ |
| New manifest/path/gate tests                                 | 42 passed                                        |
| New password-policy/scheduler tests                          | 20 passed                                        |
| `npm run typecheck`                                          | Passed                                           |
| `npm run lint`                                               | Passed                                           |
| `npm run check-format`                                       | Passed                                           |
| `npm run build`                                              | Passed; existing large-bundle warning            |
| Full Vitest suite with installed Python interpreter selected | 1,194 passed; 20 skipped; 0 failed               |
| Dedicated PostgreSQL integration/recovery                    | Not run; skipped suites are not passing evidence |
| Native Windows/Linux, keyring, voice/performance acceptance  | Not run                                          |

The first full suite attempt had one failure: `dream-analysis.test.ts`, “uses the real npm/Python protocol for a bounded no-op without account or network”, timed out while the default `uv` launcher resolved the copied environment. Selecting the already-installed interpreter through the supported runtime option passes that test and the full suite:

```sh
MYOWN_LLM_PYTHON="$PWD/node_modules/myown-llm-integrator/python/.venv/bin/python" npm test
```

No test timeout was relaxed, and the protocol fixture still executes the real Python bridge.

## Blocking dependency and remaining work

The execution environment cannot resolve `registry.npmjs.org` or `github.com` (`ENOTFOUND` / no DNS configuration). Neither `age-encryption@0.3.1` nor `tar-stream@3.2.2` is available in its npm cache. No replacement cryptography or unverified archive implementation was introduced, and dependencies/lockfile have not been changed.

After package access is restored:

1. Verify/install the pinned dependencies, restore the saved failing archive tests from this plan's execution scratch directory, and implement/test encrypted streaming archives and interoperability.
2. Integrate the maintenance gate across every writer, including final tool/voice receipts, memory jobs, telemetry, and ordinary routes. Unit tests of the primitive alone do not prove whole-workspace exclusion.
3. Capture and restore disposable SQLite/PostgreSQL workspaces, including crash recovery and no-action-replay checks.
4. Wire trusted native controls, worker execution, secure keys, destination checks, and automatic scheduling; verify actual recovery with source stores disconnected.
5. Continue the approved unified SQLite migration, Dot transfer, portable location, performance, and native-platform stages. None is complete at this checkpoint.

## Execution decisions

- Work on dependency-free portions while package access is blocked. This changes task order but does not expose incomplete backup controls or alter active storage. The cost is a checkpoint with tested helpers but no usable backup feature yet.
- The snapshot capture interface will need an optional origin (`manual` by default), so scheduled snapshots can use automatic preemption. This is a planned internal signature adjustment; its callers must be checked during capture implementation.
