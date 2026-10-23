# Dot Abilities: platform design

Status: approved by the owner on October 23, 2026; implementation and verification
are tracked in [the evidence record](abilities-verification.md). Not a release announcement.

## Outcome and agreed constraints

An Ability teaches a selected Dot a new capability. Anyone may publish one on
GitHub, with no central marketplace requirement. My Own Dots owns installation,
permission enforcement, execution, account credentials, and lifecycle; individual
Abilities live in independent repositories or directories of a collection.

The owner has agreed to these product decisions:

- Support JavaScript/TypeScript, Python, and native executables.
- Show actual requested permissions before installation or supplied code runs;
  deny everything outside approved permissions.
- Install packages once per workspace; enable, authorize, configure, and store
  private state separately for each Dot.
- Use approved capabilities without repeated action confirmations. A permission
  grant is standing authority, not a promise that the author is trustworthy.
- Require consent for additional access on updates. Other Dots inherit nothing.
- Stop Ability-owned processes when disabled or when the desktop app quits.
  Hiding or closing a window does not disable an Ability.
- App/window/desktop capabilities are in the product direction. System services,
  drivers, administrator privileges, and machine-wide dependency installs are not
  part of the initial version.
- Spotify is the first real Ability. Its user supplies their own developer-app
  client ID; sign-in uses the browser and never asks for a client secret.

Success means an owner can inspect a GitHub package, teach it to one Dot, use it
through chat and voice, and revoke it; another Dot cannot use its grants or state.
Native/Python execution must satisfy the same restrictions as JavaScript.

## Scope and delivery boundary

This spec covers the desktop Ability platform and its author contract. A separate
Spotify spec in My-Own-Dot-Abilities covers the provider-specific implementation.
Implement and verify the platform with small, first-party fixtures before adding
Spotify. Keep both repositories' main branches protected and use separate PRs.

Initial execution targets the existing macOS desktop, starting with Apple Silicon.
Declare only OS/architecture combinations exercised by real sandbox acceptance
tests; do not infer Intel or older-macOS support from TypeScript tests. Web-only,
remote-backend, Linux, and Windows execution report unavailable until equivalent
host adapters exist. An attached backend is supported only on the same machine
with an authenticated desktop session.

The first broker supports HTTPS requests, OAuth accounts, private state, and
supervised package helpers. Arbitrary computation in supported runtimes is allowed
inside the sandbox. Printing, window manipulation, Accessibility, companion
creation, and game surfaces need later, individually specified host capabilities;
the initial manifest rejects these unsupported permissions. It does not grant a
shell or unrestricted Accessibility access as a shortcut. This is the first
platform increment, not a claim that every future Ability example is supported.

## Approaches considered

1. **OS-confined workers with a host broker (recommended).** Works with native
   macOS binaries and scripts, while the host enforces scoped capabilities. It
   requires a small native launcher and real adversarial acceptance tests.
2. **Linux container or VM per Ability.** Provides a different isolation boundary,
   but cannot directly run macOS binaries or access desktop APIs; those still need
   a host broker. Adds startup and distribution requirements to this first version.
3. **Ordinary child processes plus permission declarations.** Simple authoring,
   but cannot enforce deny-by-default against arbitrary code. Does not meet the
   agreed requirement and is not a fallback.

The macOS candidate is Apple's existing Seatbelt facility, invoked by a narrowly
scoped native launcher. Its sandbox interfaces are deprecated: the installed SDK's
`usr/include/sandbox.h` explicitly says they may be removed. This is a compatibility
risk, and the feasibility tests below are a release gate. If the mechanism cannot
meet the invariants, stop this implementation path and present an alternative;
never quietly start an unrestricted worker. Existing local-voice sandbox code is
useful evidence, but its broad file, process, and Mach allowances must not be reused.

## Components and trust boundaries

- **Shared contract:** versioned manifest, permissions, messages, and validation
  in `src/shared/abilities/`. Schema and examples are the author-facing API.
- **Ability service:** `src/server/abilities/` owns workspace package records,
  per-Dot bindings, grant revisions, settings, and tool registration. It exposes
  owner-only installation/configuration routes and a separate desktop bridge.
- **Desktop Ability host:** `src/desktop/host/abilities/` owns installation files,
  sandbox launchers, worker supervision, HTTPS/OAuth operations, and encrypted
  account storage. It never loads Ability modules into Electron or the backend.
- **Agent adapter:** adds tools only from enabled, compatible bindings. It uses
  the existing TanStack tool loop and revalidation pattern in `dot-agent.ts` and
  `connection-tools.ts`; it does not add another inference engine.
- **UI:** an Abilities section for the selected Dot, using existing settings and
  owner-approval presentation patterns, plus plain result lists/cards for tools.
  Package text and result text are untrusted plain text, never executable UI.

Use a dedicated, authenticated bidirectional loopback bridge between desktop and
backend. Pair it from the existing trusted desktop connection, with a random
session credential distinct from owner credentials. Require backend authentication
even for older local workspaces that otherwise permit tokenless access. Bridge
requests are bound to workspace, desktop session, Dot, immutable package digest,
grant revision, and invocation. No model or Ability can create these identities.
Reject browser origins, unauthenticated connections, replayed requests, and other
workspace identities. Do not expose the session credential to a renderer or worker.

The backend is the durable grant authority; the desktop is the enforcement point.
Revocation closes the desktop admission gate before reporting success and bumps
the durable revision. Revalidate at dispatch and each broker operation. If either
side disconnects or cannot establish the current revision, stop accepting work
and terminate the affected workers. Changes to grants also invalidate agent turns
using the existing runtime-policy cancellation pattern.

## Package and installation contract

Use an explicit GitHub release descriptor, not a repository clone or mutable
default-branch script. Resolve the repository, release tag, source commit, asset
identity, platform, SHA-256, and declared sizes. The descriptor contains the
manifest and archive metadata; the archive contains the same manifest plus code,
licenses, and bundled runtime dependencies. A checksum binds review to bytes; it
does not certify the publisher's safety.

The manifest has a format version, stable Ability ID, display name, publisher/source
identity, package version, compatible host API range, supported platforms, runtime
and entrypoint, declared helper entrypoints, tool input/output schemas, settings,
result visibility policy, and permission requests with human-readable purposes.
Identity includes the
source repository, so an unrelated repository cannot replace another's `spotify`.
Reject unknown manifest fields and permissions for the supported format version.

1. Fetch bounded metadata without executing it. Render source, version, selected
   Dot, runtime, access, and relevant dependency/license information for review.
2. Owner selects **Teach** to approve that exact descriptor and grant set. Fetch
   and validate the corresponding archive; any mismatch invalidates approval.
3. Enforce compressed/uncompressed byte and file-count limits; reject absolute
   paths, traversal, symlinks, hard links, devices, duplicate/case-colliding paths,
   unexpected executable paths, and unsupported platform artifacts. Extract into
   a host-private staging directory, never over an existing installation.
4. Commit the package atomically into a content-addressed, worker-read-only
   directory. Record the per-Dot binding and grants. Account setup may then run
   through trusted host UI. No Ability-authored installer or UI code runs here.

Authors build dependencies before release: bundle JavaScript, Python modules, and
platform-specific libraries as needed. Do not run `npm install`, `pip install`,
postinstall scripts, or arbitrary setup commands on the owner's machine in v1.
This supports dependencies privately without creating a second, unsandboxed
execution path. TypeScript is compiled by the author; packages execute JavaScript.
A development import can use a local sealed artifact, with the same validation
and permission review; it is not a live folder with silently changing code.

Start with descriptor cap 256 KiB, compressed archive cap 256 MiB, extracted cap
1 GiB, and 20,000 entries. Exceeding a limit produces an explicit install error;
do not prompt to disable validation. Downloader redirects are limited to GitHub's
release asset delivery hosts, without forwarding credentials or allowing private
network destinations. Private repositories are outside this initial installer.

## Execution and supervision

Workers communicate over bounded newline-delimited JSON-RPC on stdio. Protocol
methods cover initialize, invoke, cancel, shutdown, and capability requests.
Stdout is protocol only; stderr is bounded diagnostics. Unknown messages, forged
request identities, oversize frames, and invalid schemas fail the invocation.
The host supplies only necessary arguments and a nonsecret settings projection,
never the conversation transcript, owner environment, credentials, or workspace.

For each worker, allow only system runtime resources, its approved runtime and
package files, and its private Dot/Ability data and temporary directories. Deny
direct network access, other user/workspace files, Keychain, broad Mach/IPC access,
app automation, process inspection/signalling, and persistence locations. Sanitize
environment, current directory, inherited descriptors, and runtime search paths.
Package files and runtime executables cannot be modified by a worker.

Use the packaged Node runtime for JavaScript. Python uses an explicitly selected,
validated local interpreter with isolated startup and reviewed runtime/library
paths; absence is a setup error, never an automatic download or a broad home-folder
grant. Native entrypoints must match declared OS/architecture and normal macOS
execution requirements; do not bypass quarantine or signing failures.

Direct child creation is denied. An Ability needing a helper requests a declared
package entrypoint through the broker; the host launches it with the same or
narrower restrictions and tracks its process identity. The trusted launcher
applies confinement before executing untrusted code. The sandbox must prevent a
worker from forking/daemonizing or escaping supervision through OS services.
This deliberately means ordinary Python multiprocessing or native subprocess APIs
need adaptation to the host helper API. A process-group kill alone is insufficient.

Workers start on demand. Initial ceilings: one active invocation per binding,
four active workers per binding including helpers, 1 MiB protocol frame, 1 MiB
HTTP response, 30-second broker request, and 60-second invocation deadline.
Serialize conflicting actions and return a busy result when the queue limit of
eight is reached. Cancelled invocations lose broker authority immediately. Workers
receive a short shutdown grace period (two seconds), then are killed and reaped.
Do not advertise these ceilings as VM-grade CPU or memory isolation.

Disable, uninstall, Dot deletion, package replacement, workspace switching,
storage restore/move, backend disconnect, and app quit revoke invocation authority
and stop all associated workers/helpers. Closing the window leaves them available.
The desktop host owns supervision even when the backend is externally managed.
A separate watchdog observes desktop/session death and kills supervised workers;
parent disappearance must not depend on cooperative Ability shutdown. Persistent
OS service registration is prohibited. External apps are never tracked as
Ability-owned children merely because an Ability controls them.

## Permission broker and accounts

Permissions are host-understood structured rules, not author-supplied executable
policy. Unknown or unapproved requests are denied. Author explanations help the
owner understand access, but cannot override the host's literal access summary.

- **Private state:** implicit baseline access only to this binding's directory,
  with no access to another Dot or package's state.
- **HTTPS:** exact HTTPS origins, methods, bounded path templates, and optional
  request-field constraints. No wildcard origins, private/link-local destinations,
  arbitrary proxies, or credential-forwarding redirects. Validate DNS results and
  the actual connection destination, not merely a URL string.
- **OAuth account:** authorization/token endpoint origins, resource origin,
  scopes, and account use shown before browser sign-in. Credentials are bound to
  Dot, package source, client ID, account, and consent revision. Requests refer to
  a host-held account handle; the broker injects authorization only at approved
  resource routes. Workers cannot set authorization/cookie headers or call token
  endpoints. Provider configuration is declarative data, not host-loaded code.
- **Package helpers:** specific immutable entrypoints and constrained arguments,
  never shell strings or arbitrary system executables.

OAuth uses PKCE S256, unpredictable state, a short-lived literal-loopback callback,
and a system-browser flow initiated from trusted UI. Expire state after five
minutes and consume it once. Bind it to the initiating Dot/session/client/scopes.
Only the host exchanges and refreshes tokens. Reuse the Electron `safeStorage`
boundary already established by backup keys, with separate Ability credential
files and no plaintext fallback. The trusted provider necessarily receives its
own token; this design does not defend against a malicious authorized provider.
Do not return token responses or sensitive headers to workers, logs, or the model.

Installation grants standing access to the displayed capabilities. Calls within
those grants need no repeated prompt, as requested by the owner. A worker only
receives broker authority during a valid invocation; no initial background tasks
or unsolicited tool calls. Never infer permission from an Ability's `readOnly`
claim, tool description, chat text, or OAuth scopes alone. The enforceable grant
is the intersection of manifest, owner consent, active binding, and provider scopes.
An ambiguous target can still require clarification; this is distinct from asking
again for already granted access.

## Storage, changes, and recovery

Store installed package identities/digests and per-Dot bindings/grant revisions in
workspace metadata through existing repository interfaces. Place archives,
immutable packages, and binding state under the configured workspace root, not
source-checkout paths. Store encrypted credentials in the desktop profile outside
portable archives. OAuth client IDs are nonsecret settings. Installation and
grant transitions must be recoverable after a crash; never run a half-installed
package or treat a pending approval as an active grant.

Versions can coexist on disk; each Dot binds to one immutable version. Updates
are explicit and show changed access. New scopes, origins, helper paths, resource
constraints, runtime/platform requirements, or publisher identity require fresh
review. A hash mismatch or moved release never changes an existing binding.
Existing code remains pinned until its replacement is approved and installed.

Disable preserves state and encrypted account material but removes execution
authority. Disconnect deletes the local account credential and explains provider
revocation where relevant. Forget removes a Dot's binding and private state after
an explicit data-deletion choice; uninstall removes unused shared packages.
Other Dots are unaffected. Dot deletion removes its Ability state and credentials.

Include nonsecret package records, manifests, and private state in portable
workspace backups using the existing archive/restore boundary. Do not export
tokens. Restored bindings start disabled, verify/reinstall pinned packages, review
access again, and reconnect accounts. Storage move on the same installation stops
workers and rebinds canonical paths before restart. No restored grant silently
authorizes execution on a different machine or host session.

## User flow and failure behavior

The selected Dot's Abilities section shows installed/available packages and concise
states: disabled, setup needed, ready, running, or blocked with a reason. **Add
Ability** accepts a release descriptor link. **Teach** reviews package identity
and actual access. Existing packages still need this Dot's independent approval.
Spotify then shows client ID, setup guide, and **Connect Spotify**. A ready Ability
becomes available to the same agent tools used by typed chat and voice delegation.

Tool errors are structured: permission denied, setup needed, unavailable host,
unsupported platform, timeout, invalid response, rate limited, and provider error.
Do not turn unknown outcomes into success. Cancelling a local request cannot undo
an external action already accepted; preserve an uncertain outcome and do not
automatically retry non-idempotent mutations. Tool output and package descriptions
are untrusted data, not system instructions. Keep diagnostics bounded and redacted.

Support an `owner-only` result policy in the first host contract. Those payloads
go directly to a bounded, plain-text UI result list/card; they never enter model
messages, conversation memory, summaries, embeddings, AI speech synthesis, or
provider telemetry. Keep them in session memory with a ten-minute expiry, clear
them on disconnect, and exclude them from portable backups. The agent receives
only host-defined action-status enums and host-minted opaque handles, never a
worker's free-form explanation or provider error body. Handle use is bound to its
Dot, invocation context, expiry, and authorized result selection. Tool follow-ups
can resolve selections locally without passing display metadata through inference.
Changing a tool from owner-only to model-visible is additional access requiring
fresh review. This lets providers such as Spotify remain usable without sending
their returned content to a model; it is not a provider endorsement of the design.

## Verification and release gates

1. **Isolation feasibility first:** native executable, Python, and JavaScript
   fixtures can use their own state but cannot read sentinel workspace/other-Dot
   files, write outside their root, open network sockets, reach host credentials,
   invoke app automation, fork, daemonize, or signal unrelated processes. Exercise
   symlink/path races, inherited descriptors, loader paths, malformed protocol,
   helper restrictions, and attempted re-execution. Use disposable fixture data.
2. **Lifecycle:** disable, revoke during a broker request, quit, desktop crash,
   backend disconnect, helper timeout, and externally managed backend all leave
   no Ability worker/helper alive. Normal window close keeps the session usable.
3. **Installation:** safe extraction, declared-size and checksum mismatch,
   release replacement, unsupported permissions, concurrent install, interrupted
   install, and update consent. No code runs before consent.
4. **Authority and accounts:** cross-Dot/workspace/session requests, stale grant
   revisions, forged identities, OAuth callback replay, refresh races, unavailable
   secure storage, redaction, DNS rebinding, and redirects. Use fake provider data.
5. **Product:** desktop permission UI, per-Dot enable/disable, chat and voice
   tool availability, owner-only payload exclusion from every inference/memory/
   voice/log path, status recovery, storage backup/restore/move, and a sealed
   package authored without importing host private code.
6. **Repository checks:** formatting, lint, typecheck, full tests with a dedicated
   test database, build, desktop packaging, and real macOS sandbox acceptance.
   Add an explicit macOS CI job; Linux CI alone cannot validate the security claim.
   No live provider account is used in CI.

Native sandbox evidence is required before enabling third-party Ability
execution. Fixture tests, source implementation, packaged
desktop verification, and live Spotify acceptance are reported separately.

## Sources and existing code examined

- `src/server/dot-agent.ts`, `connection-tools.ts`, `connection-routes.ts`, and
  `connection-store.ts`: tool routing, owner actions, and revocation patterns.
- `src/desktop/main.ts`, `host/workspace-backend.ts`, `host/workspace-window.ts`,
  and `host/backup-keys.ts`: quit, attached-backend, trusted IPC, and secret storage.
- `scripts/local-voice/native_launcher.py` and sandbox tests: existing macOS
  evidence, with permissions unsuitable for arbitrary third-party code.
- [Node permission model](https://nodejs.org/api/permissions.html): not a malicious-code sandbox.
- [Electron process sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox): renderer isolation is not a general native Ability runtime.
- [Apple sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html): spawning a process alone is not a scoped capability boundary.
