# Ability verification

## Native feasibility gate — October 23, 2026

This is a first-party confinement probe, not a completed Ability platform or a
live Spotify test. No owner data, credentials, Keychain access, provider accounts,
external network requests, dependency downloads, or package installs are involved.
The harness compiles its own C sources using the installed Apple SDK and runs the
already installed Node and Python runtimes against disposable files and processes.

Run from the project worktree:

```sh
python3 -I -S -B scripts/abilities/test_sandbox.py
```

Result: **12 tests passed**, exit 0, in 17.942 seconds. Probe commands exit 0
after reporting the operation's OS result. Forced cleanup reports worker exit
137; an intentionally failing worker reports 2. Invalid sandbox startup returns
125 without executing the worker.

Environment exercised:

- macOS 26.6.2, build 25G83; native arm64.
- Apple clang 21.0.0 (`clang-2100.3.34.2`), Xcode's macOS SDK.
- Node 24.20.0, `/Users/han/.nvm/versions/node/v24.20.0/bin/node`.
- Python 3.14.3, installed python.org framework at
  `/Library/Frameworks/Python.framework/Versions/3.14`.
  The fixture executes `Resources/Python.app/Contents/MacOS/Python` directly with
  `-I -S -B`; `bin/python3.14` is a wrapper that re-execs that interpreter.

The launcher arms kqueue owner-exit/control-pipe monitoring before releasing the
worker. The worker applies a deny-default Seatbelt profile before exec, receives
an explicit environment, and closes inherited descriptors. The supervisor keeps
the child's identity until it is reaped. Control EOF, owner exit, and stop signals
start a two-second TERM grace period, followed by KILL for an uncooperative worker.
Helpers must use separate supervisors: direct worker process creation is denied.

The initial RED run failed because the launcher was missing. Implementation also
exposed an inherited-descriptor leak when the soft descriptor limit was lowered
below an open descriptor. Its regression test failed before the fix and passed
after actual descriptor enumeration replaced reliance on the soft limit alone.

The gate checks real OS behavior for all three runtimes:

- Own-state read/write succeeds; sibling state and package modification fail with
  `EPERM`/`EACCES`. Host-side sentinel checks observe zero outside writes.
- TCP connections to a real loopback listener and Unix socket connections fail
  with permission errors, rather than an absent-listener error.
- Fork/spawn, native daemonization, and exec of an undeclared system executable
  fail. A permitted native re-exec remains supervised.
- Named Mach services resolve outside confinement but fail inside it. Signaling
  an unrelated disposable process fails and that process remains alive.
- Inherited file handles, including one above a lowered soft limit, are closed;
  injected environment variables do not reach workers.
- Control EOF and actual owner SIGKILL stop TERM-ignoring workers within three
  seconds. The owner-death test deliberately retains an open control writer, so
  it exercises process death detection independently of EOF.
- Symlinks, attempted hard links, and concurrently replaced symlinks cannot
  change a sentinel outside the state directory.
- Invalid policy fails before worker code; a worker failing before readiness is
  reaped and reported through the supervisor status pipe.

The fixture profile allows system loader libraries, the selected runtime roots,
read-only package contents, and the worker's own state. The loader on this macOS
build requires `file-read-data` on the literal `/` directory; this does not grant
read access to descendants. Directory metadata is limited to runtime/state
ancestors. There is no broad process, network, or Mach lookup allowance.

Limitations: Seatbelt's custom-profile API is deprecated in Apple's installed
SDK. These probes establish behavior only for this OS build, architecture, and
installed runtimes; they are not a proof against every OS exploit. Application
profiles, package sealing, grant enforcement, broker operations, desktop packaging,
and live account integration still require their later acceptance gates. No
unsupported platform or unsandboxed fallback is enabled by this experiment.

## Dependency preflight

The worktree and primary checkout have the same package-lock SHA-256:
`98b7ce720ee638a3ff671fae23a989dffe170b373c692d2bb721fec74abcbf08`.
Every applicable installed version matches that lock. Reuse the existing
`node_modules` through a worktree-local symlink; do not rerun installation hooks
or change the shared installation. The existing Integrator Python environment is
also present. A clean dependency installation remains the CI reproduction check.

Reviewed installed package metadata, upstream repositories/maintainers, npm
revision metadata, dependency lists, build scripts, and binary-loading paths:

| Package                      | Exact installed version                                   | Upstream / relevant execution surface                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod                          | 4.6.5                                                     | [Colin McDonnell / Zod](https://github.com/colinhacks/zod); pure JS validators, no runtime dependencies or install hook                                                                                                   |
| tar-stream                   | 3.2.2                                                     | [Mathias Buus](https://github.com/mafintosh/tar-stream), commit `d49f05b495b432d57042d461bd91036b58439c6a`; streaming parser, no extraction policy or install hook                                                        |
| tar-stream dependencies      | b4a 1.9.0, bare-fs 4.8.4, fast-fifo 1.3.2, streamx 2.28.1 | Existing locked packages; tar-stream uses Node fs constants; its extraction path does not load the Bare runtime binding                                                                                                   |
| Vitest / Vite / React plugin | 4.1.11 / 8.3.1 / 6.1.1                                    | [Vitest](https://github.com/vitest-dev/vitest), [Vite](https://github.com/vitejs/vite), [plugin](https://github.com/vitejs/vite-plugin-react); execute repository config/plugins; use fixture tests, no browser UI server |
| Rolldown / esbuild           | 1.2.11 / 0.28.2                                           | [Rolldown](https://github.com/rolldown/rolldown), [Evan Wallace](https://github.com/evanw/esbuild); existing arm64 native bindings/binary; esbuild installer can download binaries and is not rerun                       |
| TypeScript                   | 6.0.3                                                     | [Microsoft](https://github.com/microsoft/TypeScript), commit `050880ce59e30b356b686bd3144efe24f875ebc8`; existing compiler                                                                                                |
| Electron                     | 44.8.0                                                    | [Electron community](https://github.com/electron/electron); existing binary; installer downloads through `@electron/get`, not rerun                                                                                       |
| Integrator                   | 0.2.0                                                     | [Owner's published package](https://github.com/Handriantog/My-Own-LLM-Integrator); existing Python environment, jsonschema/referencing, no live inference in tests                                                        |

The October 23 npm registry audit reports **14 existing findings**: 7 low,
3 moderate, 3 high, 1 critical, with no lockfile change. These affect DOMPurify,
MCP SDK, follow-redirects, ip-address, KaTeX and their dependents, Vite, and Vitest.
The [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
concerns manual mock registration in its exposed browser/server machinery;
baseline checks use `vitest run`, with no UI/browser-mode listener. Ability
HTTP/OAuth will use the host's constrained `node:https` transport. Owner-result
UI will render text without HTML. Existing application vulnerabilities remain
maintenance work; this record does not claim they have been fixed.

Limits of this review: not every transitive source line was audited, and some npm
releases omit a source `gitHead`. Exact package versions and lockfile integrities
identify those artifacts, but do not establish safety or reproducible native
builds. No credential or Keychain access is needed for dependency evaluation.

## Application baseline before Task 2

October 23: formatting, lint, typecheck, and web/server build pass. Vitest reports
214 test files passed, 1,710 tests passed and one existing certificate-identity
test skipped. Speech checks pass 31 worker and 17 native-worker tests. The build
retains the existing large-chunk advisory. No live inference/provider call ran.

PostgreSQL is an isolated tmpfs-backed test container, `dots-abilities-test`,
using the already installed official `postgres:17.6-bookworm` image at digest
`sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3`.
It binds only loopback on an ephemeral port and mounts no owner files or volumes.
`LOCAL_TEST_DATABASE_URL` names `dots_abilities_test` with disposable fixture
credentials. Owner application databases and .env files are untouched.

## Contract, installation, and authority

The contract gate passes 29 tests plus typecheck and lint. It exercises strict
versioned manifests, constrained schemas, reference validation, permission
changes, bounded protocol messages, and the separate owner-only outcome parser.
The exported author schema is checked against the actual validator.

Installation passes 29 tests. Real temporary tar/gzip fixtures cover traversal,
links, devices, filename aliases, undeclared executables, changed manifests,
hashes/sizes, concurrent installs, interrupted downloads, and replaced parents.
No supplied worker is started. GitHub transport tests use injected DNS/HTTPS
fixtures for pinning, private/mixed answers, redirects, streamed limits, and DNS
cancellation; these are not a live GitHub release installation. Extraction roots
are host-private and unavailable to Ability workers; no claim is made about a
compromised host process running outside the Ability sandbox.

The authority/storage gate passes 243 tests across 19 files, with typecheck and
lint. Coverage includes per-Dot grants, monotonic revisions, duplicate invocation
claims, stale/foreign contexts, uncertain interrupted receipts, both storage
engines, schema-4 migration, historical restore compatibility, and workspace move
regressions. Receipts contain generic statuses, not provider/model payloads or
host package paths. The feature is not yet connected to the desktop UI or agent.
