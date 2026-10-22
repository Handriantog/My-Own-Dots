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
