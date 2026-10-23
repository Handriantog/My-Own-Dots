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

The bridge/service gate passes 15 real-loopback tests and a platform-route test.
It covers owner authentication, browser-header rejection, workspace identity,
session expiry/replay/replacement, reconnect, durable revocation, actual process
termination, concurrent authority checks, shared-package uninstall races, and
owner-only response filtering. The disposable process fixture here tests bridge
lifecycle only; OS confinement remains the separate native acceptance gate.

After connecting the backend routes, the full suite exposed a missing module in
the packaged backend. GitHub metadata review and the existing public-address
classifier now live in shared modules, with the old exports preserved. The real
owned-backup integration passes again. The full suite passes 219 files and 1,793
tests, with one existing certificate-identity skip; typecheck and lint pass.

## Application worker supervisor

Sixteen supervisor tests pass with real JavaScript, selected Python, and native
fixture programs. They cover the eight-call queue, four-worker limit including
helpers, malformed/oversized/unknown protocol frames, the exact 60-second timer
boundary, real TERM grace and forced reaping, cancellation, native architecture,
quoted paths, package replacement, environment isolation, native re-execution,
helper authority ending with the main result, and failed profile-file cleanup.
The 60-second test advances the host timer; the two-second native grace runs in
real time and checks actual process survival.

The native gate passes 13 checks with both its original fixture policies and the
application profile generator. Node/libuv uses anonymous Unix socketpairs for
child stdio, so the launcher accepts those as control/status channels while
rejecting TCP and named Unix sockets. All extra worker descriptors are still
closed. A racing symlink test now establishes safe writes before starting churn;
all 5,000 racing attempts must leave the outside sentinel unchanged. This avoids
requiring a scheduler-dependent successful write during churn.

Selected interpreter code executes inside confinement. Owner/root-owned runtime
trees may be group writable, as the installed python.org framework is; world
writable runtimes remain rejected. The trusted watchdog retains the stricter
non-group/world-writable check. Package files remain immutable to workers.

The full suite passes 220 files and 1,809 tests, with the same one existing skip;
typecheck and lint pass. Packaged Electron runtime acceptance and live provider
use remain later gates; these results do not claim VM-grade resource isolation.

## HTTPS broker

Thirty-five broker tests pass, covering route/body/header mismatch, private and
mixed DNS answers, address pinning, original TLS hostname options, revocation
before connection and before request writes, redirects, streaming byte limits,
compressed-response rejection, credential echoes, cancellation, and a stalled
DNS lookup at the exact 30-second deadline. The controlled transport records
connection and write events separately; these unit fixtures do not establish a
real socket to a rejected private endpoint.

A separate live, unauthenticated request through the production transport to
Spotify's `/v1/me` returned HTTP 401. With a controlled local proxy configured as
the global Node proxy, the probe recorded zero proxy connections. No account
credentials, login, playback, or library mutation was involved. The one-request
agent behavior is also documented in [Node's HTTP reference](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#class-httpagent).

The full suite passes 221 files and 1,844 tests, with one existing skip;
typecheck and lint pass. OAuth and authenticated Spotify behavior are not yet
implemented or verified.

## OAuth account boundary

Twenty-one OAuth tests pass using real loopback callback listeners, an injected
provider transport, and encrypted fixture files. They cover S256 PKCE, exact
callback host/path, single-use state, the five-minute state lifetime, scope
checks, rotating/concurrent refresh, consent changes, reconnect, and disconnect
racing a credential write. Stale cleanup cannot delete a replacement account.
Callback replies, account presence, errors and captured logs contain no fixture
tokens. Account files are encrypted and mode 0600; unavailable protected storage
fails before the browser opens. The eleven existing backup-key tests also pass.

The fixture uses an ephemeral AES-GCM key, not the owner's Keychain. Real
safeStorage and authenticated Spotify acceptance remain later/manual checks.
Account identity includes workspace, Dot, binding, source, digest, client ID,
consent approval and an opaque handle; disable/re-enable still invalidates old
invocations without deleting an unchanged account.

The host follows Spotify's [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
and [literal loopback redirect rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
An omitted scope field retains the requested/previous set as specified by
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749); an explicitly different set
is rejected. No client secret or token is part of the worker/renderer contract.

## Host assembly and private results

Fifteen result/IPC tests and ten assembled-host tests pass. Real confined Node
workers emit owner-only sentinel content through success, partial results, raw
errors, stderr, and cancellation. The privacy case uses the authenticated real
loopback desktop/backend bridge; its received outcomes contain only fixed status
codes and opaque references. Owner payload remains available only in the correct
Dot context, with current binding/session authority. Late results after access
changes are discarded and reported uncertain.

Selections are single-use, scoped to the workspace, session, Dot, binding,
digest, grant revision and thread. Display items use host-generated IDs; private
action data is not included in the UI reply. Plain text remains plain text, and
links must pass independent HTTPS validation. The store actively expires results
after ten minutes and also caps them at 128 entries / 16 MiB; old results may be
evicted earlier. Revoke, disconnect and quit clear results. Model-visible values
are independently checked against the declared output schema and frame ceiling.

The OAuth regression suite now has 22 tests, including cancellation of a pending
sign-in on disable while retaining an idle approved account. These fixtures do
not establish live Spotify account behavior or packaged-runtime acceptance.

## Dot tools and desktop lifecycle

The complete suite passes 226 files / 1,906 tests, with one existing signing
identity skip. Typecheck and lint pass. The native sandbox gate passes all 13
checks again. Six agent tests exercise the real Dot tool loop, including grant
changes aborting inference, per-Dot enablement, forged authority, cancellation,
source-scoped names and duplicate delivery without repeated approval prompts.

Five lifecycle tests use a separate backend process and real confined workers.
Normal desktop stop, suspend and a SIGKILL of the desktop owner all leave no live
worker while the independent backend remains alive and answers HTTP requests.
Resume establishes a fresh host session. UI lifecycle tests verify that closing
the workspace hides it without stopping Abilities; lock suspends them, and quit
waits for workspace/Ability cleanup before backend shutdown. Remote documents and
subframes cannot call Ability IPC, and consent actions require a user gesture.

The authenticated backend identity advertises its Ability storage root beside
its database. Shared packages and per-Dot state live there, including when the
backend was attached rather than launched by Dot. Credentials and watchdog
control files remain in the desktop profile. Storage maintenance hooks stop
Ability admission before work and resume afterward. Snapshot inventory and
restore-authority rules remain the next storage gate.

The controller refuses to attach without a verified workspace identity,
a supported native launcher and a validated runtime. This is source/fixture
verification; packaging and user-facing management are not complete yet.

### Teach, setup, and private result UI (Task 11)

The selected Dot has an Abilities section with release review, explicit Teach,
per-Dot enable/disable/forget, optional private-data erasure, personal OAuth client
setup, generic nonsecret settings, and native Python selection when needed.
The host supplies real package/state locations in the review. Python executable
and read roots are reviewed in a native dialog and stored privately; candidate
interpreters are inspected without execution. Voice delegations use the validated
parent conversation for private choices; only opaque handles cross the backend.

- UI tests: 11 passing, including consent-before-install, duplicate submission,
  selected-Dot changes, setup and runtime states, expired results, escaped text,
  and host-issued selection references.
- Privacy integration: five real confined-worker scenarios traverse the actual
  authenticated bridge, DotAgent, LocalAgentRunner, SQLite storage worker,
  memory indexing/model projection, compaction inference, canonical voice and
  persisted voice-event inputs. Hostile provider text, split protocol frames,
  raw errors, stderr, uncertain results, and cancelled late output do not reach
  those sinks. The owner card displays escaped sample text. No live provider
  account or model inference is used.
- Full suite: 229 files, 1,929 passed, one existing certificate-identity skip.
  Typecheck and lint pass.
- Visual/keyboard inspection remains pending: computer access to Safari was
  denied and the in-app browser was unavailable. A disposable local Vite fixture
  is prepared for normal and 360px views. Automated React checks are not a
  substitute for that inspection.

### Storage portability and shutdown acknowledgements (Task 12)

Backups with private Ability state use archive version/minimumReader 3. Existing
inventories remain v1/v2, and known SQLite schemas 2/3/4 remain readable. Captures
exclude account credentials, result memory, executable packages, and temporary
state; package descriptors and inventory records remain in the core database.
State is hash-verified and remapped to the new workspace identity on restoration.
Restored, moved, migrated, and host-rebound bindings require fresh review before
execution. Consumed invocation IDs remain consumed after fresh consent.

The desktop now keeps its authenticated bridge available during storage work so
the backend can receive an explicit quiesce acknowledgement after workers stop.
Headless backups with installed Ability records require reconnecting the desktop;
missing heartbeats alone do not prove that a frozen desktop stopped its workers.
The existing offline move/migration paths stop the desktop/backend and hold an
exclusive source ownership claim. Active workers additionally recheck authority
every 500 ms with one outstanding check, covering binding revocation outside the
normal desktop command path.

A known SQLite trigger queues cleanup when a Dot row is removed. Attachment and
tool admission erase its host credentials/state before clearing the tombstone;
failed acknowledgement keeps cleanup pending. This adds no Dot-delete UI.

Verification includes decoded archive inventories, private-data exclusion,
changed bytes and rejected links, remapped restored state, interrupted restore,
workspace moves, real PostgreSQL-to-SQLite migration, historical schemas,
consumed receipts, cleanup acknowledgement failure, and real confined state
writers stopping before capture/resuming afterwards. The packaged-runtime tests
also caught and verified a fix moving the shared directory check out of the
desktop-only module graph.

Full suite: 230 files, 1,942 passed, one existing certificate-identity skip.
Format, lint, and typecheck pass. These are disposable fixture checks, not live
Spotify-account or release-publication evidence.

## Desktop packaging dependency review (Task 13)

Reuses the exact installed lockfile; no install hooks rerun. Reviewed npm maintainers, source revisions, dependency graphs and build scripts for Electron's packages before packaging: packager 20.3.0 (`8c5cc941018b1d890c7152734972c44b9b98f268`), get 5.1.0 (`da84467eacf58f36a8d43de64a09dd2cfe491d3f`), asar 4.3.1 (`02c5b08ef8186bf5fd49ed1274ef8cd242ab196f`), osx-sign 2.7.1 (`bbe62e3f67955ed285394635c605a3256f102abe`), extract-zip 1.0.5 (`b83e459fd04c53b0a1c8438a6792df8f64be47fc`), notarize 3.1.2, universal 3.0.6 and windows-sign 2.1.0. Maintainer is `electron-cfa`; extract-zip also lists `marshallofsound` and `electronhq`.

Packager copies the build and retrieves Electron 44.8.0 from the official Electron GitHub release/cache with checksums. The existing extract-zip package loads a precompiled NAPI Rust binary; its source containment checks and binding selection were inspected, but binary reproducibility is not established. Tool scripts compile TypeScript/Rust and prepare Husky for maintainers; none are rerun here. ASAR, universal builds, notarization and external certificate signing are not requested. Local signing calls Apple's codesign with the ad-hoc identity and requires no Keychain credentials.

[Packager's historical heap-leak advisory](https://github.com/electron/packager/security/advisories/GHSA-34h3-8mw4-qw57) affects 18.3.0 and was fixed in 18.3.1. The current registry audit still reports the same 14 inherited application findings and none for these packaging versions. [get](https://github.com/electron/get/security) and [extract-zip](https://github.com/electron/extract-zip/security) list no published advisories. This is a bounded provenance/security review, not an audit of every dependency or proof of safety.

New macOS job uses GitHub's documented `macos-26` arm64 runner with an explicit architecture assertion, Node 24.20.0, and the repository's existing pinned setup-uv/3.12 interpreter setup. Linux `check` remains unchanged. Reviewed GitHub-maintained checkout v4.3.1 (`34e114876b0b11c390a56381ad16ebd13914f8d5`) and setup-node v4.4.0 (`49933ea5288caeca8642d1e84afbd3f7d6820020`): action entrypoints, npm dependencies, build scripts and security pages. Both run committed JS bundles built with ncc; checkout uses git/archive access, setup-node uses GitHub/Node runtime downloads and npm cache. Only read-only contents permission, no persisted checkout credential and no owner accounts/models are supplied. These are pinned upstream artifacts, not locally reproduced action bundles.

Runner mapping: [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Action sources: [checkout](https://github.com/actions/checkout/tree/34e114876b0b11c390a56381ad16ebd13914f8d5), [setup-node](https://github.com/actions/setup-node/tree/49933ea5288caeca8642d1e84afbd3f7d6820020).

## Packaged host acceptance (Task 13, October 23)

The desktop now bundles `native/ability-launcher`, `ability-runtime.cjs`, the public author contract and its existing production backend. The main-process controller imports that same bundled Ability host. Build/signing rejects a missing launcher. Sealed fixtures are independently implemented against JSON-RPC in JavaScript, Python standard library and C; the fixture packager imports no host code. Only GitHub metadata/download bytes are injected offline. Production hash/inventory validation, sealed extraction, invocation authority, private-state writes and confinement execute normally. This does not verify a published GitHub release or a Spotify account.

On macOS 26.6.2 arm64, Node 24.20.0, Python.org 3.14.3 and Electron 44.8.0 (embedded Node 24.22.0):

- `npm run abilities:acceptance`: **14 native tests pass in each of two profiles; 16 integration files / 221 tests pass**. Unsupported platforms fail the dedicated acceptance command instead of producing a passing skip.
- `LOCAL_TEST_DATABASE_URL=postgresql://dots_fixture:dots_fixture@127.0.0.1:52880/dots_abilities_test npm test`: **231 files / 1,945 tests pass**, one existing certificate-identity test skipped. The first full run hit the unchanged archive stream memory assertion (55,074,727 bytes against 33,554,432); its 21-test isolated run and the full rerun passed without changing that assertion. This is retained as a measurement-flakiness limitation, not claimed fixed.
- `npm run check-format`, `npm run lint`, `npm run typecheck`, and `npm run build`: pass. The existing large-bundle advisory remains.
- `python3 -I -S -B scripts/local-voice/test_worker.py` and `python3 -I -S -B scripts/local-voice/test_native_worker.py`: **31 and 17 tests pass**. No models or audio devices.
- `npm run desktop:build`, `npm run desktop:package`, and `npm run abilities:package:smoke`: pass. The actual assembled app was copied to a disposable unrelated directory; codesign deep/strict verification passed; its bundled runtime installed/invoked all three fixtures and reported `verifiedRuntimes: [native, node, python]`. `dev-source.json` is absent. The optional newer `.icon` format was unavailable; the existing `.icns` packaging path remains. Signing is local ad-hoc, not Developer ID/notarization.

Sealed Python execution exposed a framework bin launcher that re-execs; selection now inspects the actual same-framework interpreter without relaxing process creation. A real SIGSTOP desktop regression exposed a worker surviving backend lease expiry: production launchers now require three-second native renewals after current authority checks, with TERM/two-second KILL and an independent sixty-second ceiling. Normal long invocations remain alive through renewals. A prequeued-renewal regression also verifies startup accepts valid renewal bytes and rejects malformed bytes.

Visual/keyboard inspection remains unavailable: CUA explicitly denied Safari access and exposed no browser surface, including the Task 13 recheck. Automated component/IPC/privacy tests pass, but they are not visual evidence. Final independent review, current-SHA GitHub checks, Developer ID/notarization, older OS/Intel/non-macOS acceptance, published release delivery and live Spotify actions remain distinct gates.

## Spotify package integration (October 23)

The host now enforces optional per-tool text/voice channels and digest-bound
plain-text notices before Teach/Update. Spotify declares text only because its
[Developer Policy III.3](https://developer.spotify.com/policy) prohibits third-party
voice control. Required terms must be accepted before installation. Authenticated
HTTP requests retry once after a confirmed 401 and a host-owned refresh; unknown
mutation delivery and 5xx responses are never retried automatically.

Eleven real-worker scenarios install the committed sealed Spotify development
artifact from source `89573743f1be4accd4e1a643fcae1fb960b72a7e`, archive SHA-256
`672dc437bf767efa974a9f15569770b15baa8b782d083ae080216b041e04619f`.
Only GitHub download bytes and DNS/TLS provider transport are synthetic; the
production installer, broker, browser PKCE callback, encrypted account store,
bridge, runtime, grants and result projection execute normally. The fixture
transport is an in-process constructor dependency, unavailable to manifests,
settings or IPC. No live account or Keychain access is used.

These scenarios cover all eleven tools, cross-Dot isolation, notice agreement,
direct/delegated voice exclusion, 401 refresh/revocation, expired selections,
disable/re-enable/disconnect, uncertain mutation duplicate prevention across
service restart, backend disconnection and survival of an unrelated playback
stand-in. Captured model requests, durable events, memory/compaction, diagnostics
and speech inputs contain neither synthetic Spotify metadata nor credentials,
including provider-error and partial-creation paths.

The full host suite passes **233 files / 1,972 tests**, with one existing
certificate-identity skip. Format, lint and typecheck pass. Speech checks pass
31 worker and 17 native-worker tests. The final native rerun passes 14 checks
in each of two profiles and 248 integration tests in 18 files. Build and desktop
packaging pass. The relocated, ad-hoc-signed actual app passes all three
runtimes again with no development-source link. Independent review and its fix pass are complete; exact-commit remote checks
remain pending. Visual/keyboard
inspection remains unavailable; live Spotify acceptance and publication remain
separate gates.

## Independent review and fix pass

One fresh read-only review covered both complete branches, including four focused
reproductions. It found no Critical or Minor issues and three Important issues:
abnormal worker completion, post-dispatch cancellation/receipt/projection failures,
and playlist creation followed by an additions rejection could report ordinary
failure despite possible completed effects.

Regression tests first reproduced those failures. The fix pass preserves generic
uncertainty after execution or dispatch, suppresses revoked private payloads and
references, and keeps definite errors for pre-execution rejection. Playlist partial
creation keeps its link in the owner card and sends only uncertainty to the model.
Crash, malformed output, cancellation, receipt-write failure and revoked-result
regressions pass. Real sealed Spotify/agent captures cover additions rejected with
403, 503 or connection loss; each reports uncertainty and creates only one playlist.
The final full suite passes 1,972 tests with the same one existing skip.

The first push's macOS acceptance/package job passed. Linux passed 1,907 tests
but timed out the new multi-stage encrypted restore case at the default five
seconds. That case now uses the existing encrypted archive suite's 30-second
budget; runtime limits and all content/privacy assertions are unchanged. Current
commit push/PR checks must still pass before draft handoff.

All implementation rulings and costs are retained in [the decision record](abilities-decisions.md).
Visual/keyboard inspection, live account acceptance, provider branding, signed
release publication and broader platform support remain explicit gates.

## Spotify Local (October 23, development branch)

A separate `spotify-local` package now uses an enumerated Spotify-only host broker,
fixed Apple Events and app-scoped Accessibility sessions. No OAuth/API account
setup is used. Local descriptor selection uses a bounded snapshot and the normal
sealed installer/permission review. See [setup and limits](../abilities/spotify-local.md).
The existing Spotify Web API worker remains separate and text-only.

The final full host suite passed **241 files / 2,072 tests**, with the existing one
certificate-identity skip, using a dedicated disposable PostgreSQL database on
port 52880 (`dots_test`), never the owner's application database. The filtered-menu
regression passes its 16-test suite. Latest macOS acceptance passes
**14 native confinement tests in each of two profiles and 348 integration tests
in 26 files**. This includes the real sealed Spotify Local worker with synthetic
app transport, voice admission, private two-step selection, one-use references,
Disable cancellation and uncertain-delivery behavior. Speech workers pass **31
and 17 tests**. Format, lint, typecheck and production build pass. Final desktop
packaging and the relocated, ad-hoc-signed app smoke pass for JavaScript, Python
and native workers. The smoke also checks the Automation usage description and
offline Spotify helper validation without accessing Spotify. Exact-commit push
and pull-request CI links are recorded in the draft PR after they finish.

Live testing used an isolated Electron test harness loading the production
transport and compiled helper, with explicitly authorized temporary macOS access.
Verified against Spotify: track search including changing the query, visible
playlist listing, supplied-track playback, pause, saving the current song,
private playlist creation and adding the selected recording. This caught two
regressions: AXStaticText stored its text in AXValue, and filtering replaced a
playlist-menu handle before dispatch. Both have failing-then-passing regressions;
the corrected workflows passed live. Exact focus is checked after a bounded wait
for Chromium's asynchronous update. No mutation is automatically replayed.

The disposable private `Dot Ability Test` playlist remains with one selected song.
Liked Songs was restored and playback paused. The test app's Accessibility and
Spotify Automation grants were revoked and the app quit. The app's temporary
ad-hoc signature needed an updated Accessibility entry after rebuild; first-run
permission prompting is not claimed verified. The final My Own Dots package has
not run these live account actions through the conversational UI.

Chrome at 760px and 360px verified actual React/CSS local source review, declared
OS access, wrapping filesystem paths, and the Teach transition with a synthetic
bridge. Earlier result-button wrapping and Forget-checkbox spacing issues were
corrected and rechecked. This supersedes the earlier unavailable-browser notes
for those component views, but does not establish live native chooser acceptance.

Not live-verified: skip/previous, volume, seek, shuffle/repeat, album/playlist
playback, playlist search, microphone voice invocation, all Spotify layouts/tiers,
and other platforms/locales. No release or merge has been performed. The host's
text/voice admission for local control is technical behavior, not a policy
exemption claim. [Apple's Automation permission API](https://developer.apple.com/documentation/coreservices/3025784-aedeterminepermissiontoautomatet)
and [Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
were consulted during permission diagnostics; no OS protections were bypassed.

The Spotify Local final review reproduced a custom package forwarding private
Spotify results through a model-visible tool. The fix requires every tool in an
app-control package to be owner-only, both during manifest validation and runtime
authorization, including previously bound packages. Three regressions failed
before the fix and pass afterward; checking the whole package prevents another
tool from forwarding retained private state. Explicit HTTPS grants remain a
separate network-disclosure boundary. The review's README table issue is fixed.

The sealed Spotify Local fixture comes from clean collection commit
`3449c6e4399cde1fd3b2ff43324b4ee81d826755`, archive SHA-256
`390ee4eb43490d19fc0daefea56b803245fb1a270620452afdaf538391db20a3`.

One final acceptance run was interrupted by idle sleep: macOS power logs show
704 seconds of sleep from 11:54:55 to 12:06:39, matching four unrelated test
timeouts. The unchanged suite passed in 11.88 seconds after its native probes
when rerun under a process-bound idle-sleep assertion. No test/runtime deadlines
or assertions were relaxed.

## Central management feedback — October 23, 2026

Abilities now lives below Memory in workspace navigation. Installation/review is
central; new installs are disabled and unassigned. The workspace master switch
preserves per-Dot selections, while Apply to all Dot targets the current Dot
snapshot only. Dot settings list installed packages and retain per-Dot setup.
Schema 5 persists master state and required defaults. Historical SQLite and
legacy backups, including unbound packages, restore without trusted authority.

A four-second desktop event-loop stall reproduced permanent host loss after the
three-second lease expired. Recovery now makes one guarded attachment attempt
with a fresh session, never replays an action, and cannot evict a different active
desktop. A further loss offers Reconnect. Safe diagnostics record only stage/code.
The prior owner startup log had a fourteen-second gap; attribution of that
historical error remains an inference. The rebuilt app connected and loaded the
real local Spotify permission review with the package and workspace storage paths.
Chrome component checks covered 760px and 360px layouts and master/apply controls.

Review regressions cover restored individual enablement, competing versions on
one Dot, unbound legacy restore trust, and clearing transient reconnect messages.
Final full suite: **2,094 passed, one existing signing-identity skip** against a
dedicated PostgreSQL test container. Lint, types, format, production build,
31 speech-worker and 17 native-speech protocol checks pass. The relocated, signed
app smoke verifies native/JavaScript/Python runtimes and the offline Spotify helper.
Collection: 126 tests.

This session could not complete the native acceptance gate: both profile runs
passed 13 of 14 probes; the OS-service probe failed its _unconfined baseline_
because the required macOS service was unavailable. No confinement assertion was
weakened or skipped. Standard packaging could not fetch GitHub checksums through
the session resolver; local packaging used the cached pinned Electron 44.8.0 ZIP
and verified it against that installed Electron package’s bundled checksums.
Both feedback branches have been pushed. Remote checks must be assessed for the
current commit independently of this local record; see host PR #12 and collection
PR #2 for the push and pull-request runs. The final packaged app also verified the
central page, per-Dot empty state, and manual Reconnect recovery. Spotify account
actions were not repeated during this management-only verification.

The final packaged-app check exposed a separate catalog preload bug: background
refreshes were incorrectly gesture-gated, producing a false disconnected or load
error once user activation expired. A failing preload regression reproduced it;
classifying the read-only catalog alongside existing reads fixes it. The same
regression verifies that install, master, apply-all and per-Dot assignment still
require a user gesture. The full dedicated-database suite then passed again.

The rebuilt package’s first offline Spotify-helper validation hit its five-second
process deadline. The unchanged smoke command passed on rerun; no timeout or
assertion was relaxed. Final UI reattachment through computer use is tracked
separately from this automated result.

## Completed voice-task chat recovery — October 23, 2026

The reported immediate “current turn returned no response” occurred when typing
into a completed **Voice task** conversation. Read-only inspection confirmed its
completed delegation, with no new persisted run. The coordinator rejected every
later request before recording a run, including a fresh owner message. A
separate disposable completed-task fixture reproduced the same rejection through
the full Chrome chat screen and packaged backend.

Completed tasks now accept fresh user messages as ordinary conversation turns.
Their original job, result and parent receipt remain unchanged. Empty replays,
reused task run IDs, active-task interference and invented tool continuations
remain rejected. A new follow-up can complete its own pending approval cards.
The new turn uses its own conversation/page scope and text Ability permissions;
it no longer inherits the completed job's parent voice context.

Chat preserves specific current-turn SDK errors, including voice and tool
follow-ups. Reconnect reports pending, success or failure, and never resubmits the
message. Failed initial/reconnect requests keep sending disabled, including a
bare backend RUN_ERROR before replay starts. Historical replay errors do not
make a later connection or turn fail. Regression tests use the installed SDK;
the coordinator and native-voice integration use disposable SQLite workspaces.

The isolated live Codex probe authenticated successfully but failed before
inference while synchronizing managed preferences. This session-level result
is separate from the confirmed completed-task rejection; no login, managed
preference or security setting was changed. Native app inspection continued to
time out, so Chrome and packaged-backend verification are recorded separately
from live acceptance in the owner's desktop window. The local relocated-package
smoke also timed out in the unchanged offline Spotify helper on two attempts;
its assertions and deadline were retained.

Final local source checks: **2,110 passed, one existing signing-identity skip**
across 241 test files with a dedicated PostgreSQL test database. Format, lint,
typecheck, production build and the 31+17 speech-worker checks pass. Independent
review found and corrected the bare connection-error case before this run.
