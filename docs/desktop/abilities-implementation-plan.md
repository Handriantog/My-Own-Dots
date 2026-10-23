# Dot Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install GitHub-distributed Abilities and run them for explicitly authorized Dots, with enforced confinement and desktop-owned lifecycle.

**Architecture:** The backend owns durable grants and tool registration; the desktop owns packages, confined processes, accounts, and resource access. Workers use stdio JSON-RPC, while an authenticated loopback bridge carries host commands and safe results. Provider content marked owner-only stays in desktop session memory and reaches the UI through trusted IPC.

**Tech Stack:** Existing TypeScript/Node 24+, Electron, React, Zod, SQLite storage worker, Vitest, and tar-stream; Apple SDK C launcher; Python standard-library acceptance harness. No new third-party runtime dependency is planned.

**Spec:** [Approved platform design](abilities-design.md). Spotify has a separate implementation plan in My-Own-Dot-Abilities.

## Global Constraints

- Reuse `/Users/han/MyOwnStack/My-Own-Dots/.worktrees/abilities`, branch `feat/abilities`; never implement in the primary checkout or another project's worktree.
- Support JavaScript/TypeScript, Python, and native executables. TypeScript is compiled by the author; packages execute JavaScript.
- Initial execution targets the existing macOS desktop, starting with Apple Silicon. Declare only OS/architecture combinations exercised by real sandbox acceptance tests.
- Show actual requested permissions before installation or supplied code runs; deny everything outside approved permissions.
- Use approved capabilities without repeated action confirmations. Unknown manifest fields, permissions, or capabilities are rejected.
- Install packages once per workspace; enable, authorize, configure, and store private state separately for each Dot.
- Require consent for additional access on updates. Other Dots inherit nothing.
- Stop Ability-owned processes when disabled or when the desktop app quits. Hiding or closing a window does not disable an Ability.
- No system services, drivers, administrator privileges, machine-wide installs, direct worker sockets, direct child creation, or unsandboxed fallback.
- Descriptor cap 256 KiB; compressed archive cap 256 MiB; extracted cap 1 GiB; 20,000 entries.
- One active invocation per binding; four active workers per binding including helpers; queue limit eight; 1 MiB protocol frame; 1 MiB HTTP response; 30-second broker request; 60-second invocation deadline; two-second shutdown grace.
- OAuth state expires after five minutes. Owner-only result payloads expire after ten minutes and are never persisted, backed up, or sent to inference or AI speech.
- Authors bundle dependencies; no end-user npm/pip installs or setup scripts. Review unfamiliar dependencies before execution, including existing packages that have not been reviewed in this worktree; record upstream/revision/advisories/scripts/binaries and unresolved risks.
- All test data is disposable. Full tests use a dedicated `LOCAL_TEST_DATABASE_URL`; never owner application data. No real provider accounts in CI.
- Keep main protected. Run checks, push, wait for current-commit push checks, then open PR and verify its checks. Publishing a release and live account mutations are separate authorized operations.

## Review Focus

1. Replacing an existing directory with a symlink between review and use must not expose another Dot's state or change approved bytes — Tasks 1, 3, 6.
2. Disable racing with refresh, network dispatch, or helper launch must prevent later side effects and settle one receipt — Tasks 4–9.
3. Desktop death while attached to a persistent backend must leave no worker/helper, even if code ignores shutdown — Tasks 1, 6, 10.
4. Owner-only content in exception messages, streaming fragments, or late voice results must never enter persisted events or inference — Tasks 9–11.
5. A backup, interrupted update, or app restart must not resurrect a stale grant, replay a mutation, or reactivate a restored package — Tasks 3, 4, 12.

## Execution order and file map

Task 1 is a hard feasibility gate. Tasks 2–9 establish independently tested host boundaries; Tasks 10–12 connect them to Dot; Task 13 proves the packaged workflow. Spotify starts after the public contract and host acceptance pass. Do not mark a later task complete from mocks of an earlier security boundary.

Before executing tests that need dependencies, record the lockfile and installed-tool provenance in `docs/desktop/abilities-verification.md`. Complete the required unfamiliar-dependency review, then use `npm ci` and `npm run setup:llm` in this worktree if setup is needed. Run the existing CI checks against a dedicated test database to establish the baseline; document pre-existing failures before attributing any failure to Ability changes. Do not copy owner `.env` files, credentials, or application databases. Task 1's standalone standard-library/Apple SDK harness can run before npm setup.

| Area                      | New files and responsibility                                                                                                             | Existing integration points                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Confinement               | `native/ability-launcher/main.c`, `src/desktop/host/abilities/sandbox.ts`, `scripts/abilities/test_sandbox.py`                           | `scripts/build-desktop.mjs`                                                                                              |
| Public contract           | `src/shared/abilities/{manifest,protocol,permissions,types,limits}.ts`, `docs/abilities/{manifest.schema.json,protocol.md,authoring.md}` | Existing Zod and TanStack tool schema conventions                                                                        |
| Install                   | `src/desktop/host/abilities/{github,package,installer}.ts`                                                                               | Reuse audited path-validation primitives from `src/server/storage/archive-paths.ts`; do not reuse backup-specific format |
| Authority                 | `src/server/abilities/{store,service,routes,host-bridge,tools}.ts`                                                                       | `workspace.ts`, `platform.ts`, `app.ts`, storage repository contract/worker/client, runtime policy                       |
| Host operations           | `src/desktop/host/abilities/{bridge,supervisor,http,credentials,oauth,host,results}.ts`                                                  | `workspace-window.ts`, `workspace-backend.ts`, `main.ts`, safeStorage boundary                                           |
| UI and IPC                | `src/shared/abilities/desktop.ts`, `src/client/abilities/{AbilitiesSection,PermissionReview,AbilityResultCard}.tsx`                      | `DotConfiguration.tsx`, `ChatTranscript.tsx`, workspace/chat preloads and bridge types                                   |
| Lifecycle and portability | `src/server/storage/ability-snapshot.ts`                                                                                                 | Snapshot, restore, portable-binding, workspace-move and storage controller                                               |

Test files are listed in each task. Use existing test conventions, not a separate framework. Plan documents use the repository's tracked `docs/desktop/` convention; `docs/superpowers/` is intentionally ignored here.

## Task 1: Prove native confinement and parent-death supervision

**Files:** Create `native/ability-launcher/main.c`, `scripts/abilities/test_sandbox.py`, `scripts/abilities/fixtures/{native.c,python.py,node.mjs}`, `docs/desktop/abilities-verification.md`.

**Interfaces:** Produce a trusted launcher CLI: `ability-launcher --profile PATH --control-fd FD --status-fd FD -- ABSOLUTE_EXECUTABLE [ARG...]`. The parent watches the control pipe and child identity; the child applies the profile, closes extra descriptors, and execs. The harness owns compilation and test-only profile generation; application profile generation belongs to Task 6.

- [ ] Write standard-library acceptance tests `test_private_paths`, `test_no_direct_network`, `test_no_fork_or_daemon`, `test_no_os_services`, `test_no_inherited_handles`, `test_parent_death`, and `test_path_replacement`. Each runs all applicable native/Python/Node fixtures against temporary sentinels. Assert denied access is an OS permission error, own-state access succeeds, no outside file changes, and all recorded worker PIDs disappear within three seconds of control EOF. Include ignored TERM, re-exec, child-launch attempts, and runtime failure before readiness.
      Pin observable reports with `self.assertEqual(report['outside_writes'], 0)` and `self.assertEqual(report['surviving_workers'], [])`; the harness, not the untrusted fixture, observes these values.
- [ ] Run `python3 -I -S -B scripts/abilities/test_sandbox.py`. Expected RED: missing launcher or assertions detecting prohibited access. Missing runtimes, compiler, or sandbox support are explicit unavailable gates, not passing skips.
- [ ] Implement the launcher with system C APIs, Seatbelt, a parent-death/control-pipe watchdog, and fail-closed startup. Use no daemon registration. Parent/child startup acknowledgment must ensure the watchdog is active before untrusted code runs. Resolve system runtime dependencies narrowly; do not copy local voice's broad profile. No shell evaluation or untrusted environment inheritance.
- [ ] Rerun the command for real native, Python, and Node workers. Record macOS build, architecture, compiler/runtime paths and versions, tested attacks, exit codes, and limitations in `abilities-verification.md`. If any confinement/lifecycle invariant fails, stop before other product code and revise the approach with the owner.
- [ ] Commit only this gate's source, fixtures, and evidence: `test: prove Ability sandbox boundaries`.

## Task 2: Freeze the public manifest and worker protocol

**Files:** Create the shared contract and author docs from the file map; `tests/abilities/contract.test.ts`; `tests/fixtures/abilities/{manifest.json,protocol.json}`.

**Interfaces:** Export `parseManifest(value: unknown): AbilityManifest`, `parseReleaseDescriptor(value: unknown): ReleaseDescriptor`, `parseWorkerMessage(value: unknown): WorkerMessage`, and `permissionDiff(previous: AbilityManifest, next: AbilityManifest): PermissionChange[]`. Define exported `Binding`, `InvocationContext`, `InvocationRequest`, `InvocationOutcome`, `OwnerResult`, `CapabilityRequest`, `CapabilityReply`, `VerifiedPackage`, and `InstallReview` in `types.ts`; infer structured manifest types from validators.

- [ ] Write assertions for strict format/API version 1, canonical source identity, unsupported runtime/permission rejection, escaped route segments, malformed tool schemas, and bounded messages. Pin numeric limits with `expect(abilityLimits.frameBytes).toBe(1024 * 1024)` and `expect(abilityLimits.invocationMs).toBe(60_000)`. Assert an owner-only to model-visible change appears in `permissionDiff`.
- [ ] Run `npm test -- tests/abilities/contract.test.ts`; expect missing exports/failed validation assertions.
- [ ] Define immutable manifest identity as repository owner/name plus Ability ID; package identity adds version and archive digest. Freeze JSON-RPC methods `initialize`, `invoke`, `cancel`, `shutdown`, and worker-to-host `capability`; forbid dynamic tool discovery. `InvocationContext` binds workspace/session/Dot/digest/grantRevision/invocationId/tool/threadId, supplied only by the host. The request adds validated arguments, nonsecret settings, and optional privately resolved selection data. The agent supplies only the opaque selection handle; only the desktop resolves it to worker-local action data. Outcome is a strict union of success, selection-needed, uncertain, and host-defined error codes.
      Use wire statuses `success`, `selection_needed`, `uncertain`, and `error`; error codes are `permission_denied`, `setup_needed`, `host_unavailable`, `unsupported_platform`, `timeout`, `invalid_response`, `rate_limited`, `provider_error`, `busy`, and `cancelled`. An owner-only outcome has no free-form model-visible message field.
- [ ] Define permissions as named HTTPS rules, OAuth configurations, and declared helper entrypoints. HTTP requests refer to a rule ID plus path/query/body values, never an arbitrary URL. Use bounded literal path segments and a deliberately limited schema vocabulary; reject external references, recursive schemas, executable expressions, and arbitrary regex. Define owner results as escaped text/list items with private JSON action data, opaque selections and separately validated HTTPS links; no HTML or scripts. Bind action data to the result's original source/digest/Dot/account/grant revision and expiry. Export the schema and protocol examples from these definitions and document exact wire fields for Spotify authors.
- [ ] Rerun the focused test and `npm run typecheck`; expect pass. Commit: `feat: define Ability package and worker API`.

## Task 3: Install only the artifact the owner reviewed

**Files:** Create `github.ts`, `package.ts`, `installer.ts` under the host directory; `tests/desktop/abilities-install.test.ts`; `tests/fixtures/abilities/archive.ts`.

**Interfaces:** `resolveGitHubRelease(url: string, signal: AbortSignal): Promise<InstallReview>`; `verifyAbilityPackage(archivePath: string, review: InstallReview, stagingRoot: string, signal: AbortSignal): Promise<VerifiedPackage>`; `AbilityInstaller.prepare(review: InstallReview, signal: AbortSignal): Promise<VerifiedPackage>`. Installer receives host-owned storage paths in its constructor and cannot grant execution.

- [ ] Add archive fixtures and tests for traversal, symlink/hardlink/device entries, Unicode/case collisions, absolute paths, extra manifest keys, executable mismatches, archive bombs, moving tags/assets, truncated streams, concurrent installs, hash mismatch, and parent-directory replacement. Assert zero process starts before and after a failed install; inspect source identity and digest in the review.
      The invalid-archive cases assert `expect(spawnCalls).toHaveLength(0)` and `expect(outsideSentinelAfter).toEqual(outsideSentinelBefore)` using host-side observations.
- [ ] Run `npm test -- tests/desktop/abilities-install.test.ts`; expect RED for absent installer/validation.
- [ ] Implement bounded GitHub metadata resolution and public release downloads, with fixed approved GitHub asset delivery hosts, no private-IP redirects or credential forwarding. Use `tar-stream` and existing path-validation primitives after dependency review. Require regular files and allowed entrypoints; compare the packaged manifest with reviewed metadata. Extract into a private staging root, verify content digest and sizes, atomically promote under `abilities/packages/<sha256>`, and clean failed staging. Do not execute package code, chmod quarantine away, or run installers.
- [ ] Rerun tests; assert simultaneous installs converge on the same verified immutable package and interrupted promotion cannot activate a partial install. Commit: `feat: install reviewed Ability artifacts`.

## Task 4: Persist per-Dot authority and invocation receipts

**Files:** Create `src/server/abilities/store.ts`, `tests/abilities/store.test.ts`; modify `workspace.ts`, `storage/{repository-contract,runtime-repositories,storage-worker,storage-client,runtime-policy,sqlite-schema}.ts`, `src/shared/workspace-manifest.ts`.

**Interfaces:** `AbilityStore` exposes `recordPackage(pkg)`, `bind(dotId, digest, grants, settings): Binding`, `list(dotId): Binding[]`, `get(bindingId): Binding | undefined`, `revoke(bindingId): Binding`, `configure(bindingId, settings): Binding`, `forget(bindingId): void`, `fingerprint(dotId): string`, `claimInvocation(context): boolean`, and `settleInvocation(invocationId, outcome): void`. Argument/return structures use Task 2 types; these methods are explicitly allowlisted in the async repository protocol. `bind` updates an existing source/Ability binding atomically. `configure` validates nonsecret settings, bumps the revision, and forces reconnection when the OAuth client ID changes.

- [ ] Write tests with temporary SQLite: another Dot has no binding; revisions increase even during the same millisecond; duplicate invocation ID is claimed once; a revoked or mismatched digest/revision cannot be claimed; interrupted receipts become uncertain on restart. Test fresh and migrated workspace databases in both existing storage modes.
      After revoking A's binding, assert `expect(store.claimInvocation(oldContext)).toBe(false)` and `expect(store.list(dotB)).toEqual([])`.
- [ ] Run `npm test -- tests/abilities/store.test.ts tests/worker-runtime.test.ts tests/runtime-scope.test.ts`; expect RED.
- [ ] Add strict metadata tables for packages, bindings, and generic receipts. Keep credentials and owner-result payloads out of SQLite. Integrate via `WorkspaceStore` and async repositories, preserving serialized worker transactions. Add the Ability fingerprint to `RuntimePolicy.turnState`; increment storage schema with a migration preserving existing records. Activation requires the approved digest and exact grant revision, not an author version string.
- [ ] Rerun focused tests and typecheck; verify rapid concurrent revoke/claim ordering. Commit: `feat: store per-Dot Ability grants`.

## Task 5: Authenticate the desktop bridge and serialize revocation

**Files:** Create `src/server/abilities/{service,host-bridge,routes}.ts`, `src/desktop/host/abilities/bridge.ts`, `tests/abilities/bridge.test.ts`; modify `src/server/{app,platform}.ts`.

**Interfaces:** Define `AbilityHostPort` in `host-bridge.ts` with `install(review, signal): Promise<VerifiedPackage>`, `invoke(request, signal): Promise<InvocationOutcome>`, `revoke(bindingId, revision): Promise<void>`, `disconnect(bindingId): Promise<void>`, `eraseState(bindingId): Promise<void>`, `uninstall(digest): Promise<void>`, and `stop(): Promise<void>`. `AbilityService` exposes `review(dotId, url)`, `teach(dotId, reviewId)`, `enable(bindingId)`, `update(bindingId, reviewId)`, `configure(bindingId, settings)`, `disable(bindingId)`, `disconnect(bindingId)`, `forget(bindingId, eraseState)`, `uninstall(digest)`, `tools(dotId)`, and `invoke(request, signal)` using repository authority and an injected host port. Public route bodies are separately validated and cannot supply `InvocationContext`.

- [ ] Write bridge tests rejecting absent owner authentication, remote/nonliteral-loopback backends, browser Origin/Sec-Fetch headers, workspace identity mismatch, expired session, stale sequence number, forged binding, and replaced desktop session. Assert `await service.disable(id)` leaves host admission closed before returning; a disconnected host cannot dispatch.
      A fixture records actual worker launches; after disable resolves, `expect(launchesAfterDisable).toEqual([])` even when stale commands arrive.
- [ ] Run `npm test -- tests/abilities/bridge.test.ts`; expect RED.
- [ ] Use existing Hono streaming for backend-to-desktop SSE commands and authenticated POST acknowledgments/capability checks. Pair with owner authentication and local workspace identity/challenge; mint a distinct 256-bit session token that stays in main-process memory. Bridge endpoints use their own narrow authentication middleware, outside ordinary owner API middleware, without creating an unauthenticated route. Heartbeat every second, close admission after three missed heartbeats, and re-pair after reconnect; never restore in-flight work. Serialize per-binding revoke/check/dispatch, bump durable revisions, and invalidate old session commands. Tokenless attached workspaces show setup-needed until authenticated. Enable reuses existing approved grants only for the same verified digest and settings; updates always bind the exact reviewed descriptor and display any expanded access. Refuse uninstall while another binding references the digest.
- [ ] Rerun tests with a real loopback fixture server, reconnect races and replayed command bodies; confirm only safe response envelopes are logged. Commit: `feat: pair Ability host with workspace`.

## Task 6: Supervise protocol workers and declared helpers

**Files:** Create `src/desktop/host/abilities/{sandbox,supervisor}.ts`, `tests/desktop/abilities-supervisor.test.ts`; extend native acceptance fixtures from Task 1.

**Interfaces:** `buildSandboxProfile(input: { packageRoot: string; stateRoot: string; temporaryRoot: string; executable: string; runtimeReadRoots: string[] }): string`; `AbilitySupervisor.invoke(request: InvocationRequest, signal: AbortSignal): Promise<WorkerResult>`; `stopBinding(bindingId: string): Promise<void>`; `stopAll(): Promise<void>`. `WorkerResult` is the validated worker outcome plus optional owner payload, defined in this module. Constructor receives verified runtimes/packages and a capability handler `(context, request, signal) => Promise<CapabilityReply>`.

- [ ] Test exact limits: ninth queued call rejected, second active invocation serialized, fifth live worker denied, oversize/malformed frames rejected, 60-second timeout, two-second TERM grace then KILL/reap. Assert cancellation drops authority before another helper starts. Test Python startup isolation, native architecture rejection, quoted paths, swapped directories and a re-exec attempt.
      Assert `expect(maxConcurrentWorkers).toBeLessThanOrEqual(4)` and `expect(survivorsAfterStop).toEqual([])` from launcher status and OS process observations.
- [ ] Run `npm test -- tests/desktop/abilities-supervisor.test.ts`; expect RED.
- [ ] Generate only the narrow verified profiles established in Task 1. Launch through the trusted native supervisor with sanitized environment, private cwd, separate control/status descriptors, and stdio protocol bounds. Use packaged Node and an explicitly selected validated local Python interpreter; no automatic runtime downloads. Helpers must be sealed manifest entrypoints with no wider grants, share the invocation deadline, and count toward four-worker limit. Unknown protocol methods terminate the invocation. Track real process identity, not just reusable PID numbers.
- [ ] Rerun focused tests and `python3 -I -S -B scripts/abilities/test_sandbox.py`; exercise the application-generated profiles in the acceptance harness as well as fixture profiles. Commit: `feat: supervise confined Ability workers`.

## Task 7: Enforce HTTPS permissions at the connection boundary

**Files:** Create `src/desktop/host/abilities/http.ts`, `tests/desktop/abilities-http.test.ts`.

**Interfaces:** `AbilityHttp.request(context: InvocationContext, request: CapabilityRequest & { kind: 'https' }, signal: AbortSignal): Promise<CapabilityReply>`. Constructor receives grant revalidation and credential lookup callbacks, not tokens from workers. A credential is scoped to an approved account/rule and never appears in the reply type.

- [ ] Test rule/path/method/body mismatch, percent-encoded separators, userinfo URLs, prohibited headers, private IPv4/IPv6/mapped addresses, mixed DNS answers, DNS rebinding, unexpected redirects, 1 MiB streaming limit, 30-second deadline, response decompression limit, and revoke-before-connect. Assert the actual socket destination is the validated address and TLS still validates the original hostname.
      In rejected-destination/revocation cases, `expect(bytesSentToRejectedPeer).toBe(0)`; the fixture transport must observe connections and writes separately.
- [ ] Run `npm test -- tests/desktop/abilities-http.test.ts`; expect RED.
- [ ] Implement with `node:https`, an injected resolver for tests, and a pinned validated address per connection. Construct URLs from approved rules and constrained values. Reject redirects for credentialed/provider requests; do not inherit proxy/cookie configuration. Recheck authority immediately before sending bytes; abort pending requests on revoke. Return bounded status/selected headers/body to the confined worker, with authorization/token data removed. Network exceptions exposed beyond the host use typed codes, not raw errors.
- [ ] Rerun tests including a controlled DNS-rebinding fixture without contacting real private services. Commit: `feat: enforce Ability network grants`.

## Task 8: Keep OAuth accounts inside the desktop host

**Files:** Create `src/desktop/host/abilities/{credentials,oauth}.ts`, `tests/desktop/abilities-oauth.test.ts`.

**Interfaces:** `AbilityCredentials.read(key: AccountKey): Promise<StoredAccount | undefined>`, `write(key, account): Promise<void>`, `remove(key): Promise<void>`; `AbilityOAuth.connect(bindingId: string, clientId: string): Promise<void>`, `authorize(context, ruleId): Promise<string>`, `disconnect(bindingId): Promise<void>`. Define `AccountKey` and private `StoredAccount` here; key includes workspace, Dot, source, client ID, account handle, and consent revision. Token-bearing interfaces remain host-internal and are never exported to shared types.

- [ ] Test PKCE S256, state TTL 300,000 ms, wrong/replayed callback, port/path mismatch, cross-Dot callback, cancellation, omitted scopes, expired tokens, rotating refresh tokens, concurrent refresh, revoke racing refresh, and unavailable safeStorage. Assert no plaintext credential file, token response, or credential string reaches worker/renderer/log captures.
      Pin replay and refresh ordering with `expect(tokenExchangesForState).toBe(1)` and `expect(parallelRefreshRequests).toBe(1)`; rejected callbacks have zero exchanges.
- [ ] Run `npm test -- tests/desktop/abilities-oauth.test.ts`; expect RED.
- [ ] Reuse the `ProtectedStorage` structural boundary from backup keys with separate encrypted files, atomic writes, and no plaintext fallback. Bind the callback to `127.0.0.1` on an available port and close it after one matching response/timeout. Open only the reviewed authorization origin from trusted UI. Exchange/refresh through host-only HTTPS with no redirects; serialize refresh by account key and recheck grants before storing new tokens. Keep client ID nonsecret; workers receive only account presence/handle. Disconnect clears tokens and all associated transient results.
- [ ] Rerun tests with a fake local provider through a test-only injected transport, never a production permission bypass. Commit: `feat: manage Ability OAuth accounts securely`.

## Task 9: Assemble the host and isolate owner-only results

**Files:** Create `src/desktop/host/abilities/{host,results}.ts`, `src/shared/abilities/desktop.ts`, `tests/desktop/abilities-results.test.ts`, `tests/desktop/abilities-host.test.ts`.

**Interfaces:** `AbilityHost` implements Task 5's host operations and composes installer/supervisor/HTTP/OAuth. `OwnerResultStore.put(context, result): string`, `read(dotId, handle): OwnerResult | undefined`, `select(dotId, handle, itemId): string`, `clearBinding(bindingId): void`, `clear(): void`. Handles and selections are cryptographically random, scoped, expiring, and contain no provider identifiers. Shared desktop IPC methods are `review`, `teach`, `enable`, `update`, `configure`, `connect`, `disable`, `disconnect`, `forget`, `uninstall`, `results`, and `select` with strict argument/result schemas.

- [ ] Test a worker emitting sentinel metadata in success, partial results, raw error, stderr, and cancelled late response. Assert the bridge response contains only allowed status enums/opaque handles; owner payload is retrievable only in the correct Dot context and is gone after 600,000 ms, disconnect, revoke, or quit. Model-visible outcomes obey their own schema and size cap.
      Assert `expect(JSON.stringify(bridgeResponses)).not.toContain('OWNER_ONLY_SENTINEL')` and, after expiry, `expect(results.read(dotId, handle)).toBeUndefined()`.
- [ ] Run `npm test -- tests/desktop/abilities-results.test.ts tests/desktop/abilities-host.test.ts`; expect RED.
- [ ] Dispatch capability calls with the bound invocation context; reject any worker-supplied identity. Store owner payloads in host session memory and project the agent outcome before any bridge/telemetry callback. Never use raw exception messages as status text. Validate UI links independently of display text and prohibit executable markup. Connect account-state and cancellation cleanup, and reject stale result selections.
- [ ] Rerun tests with real fixture workers and fake HTTP/OAuth; confirm no owner-only body crosses the backend bridge even on failed validation. Commit: `feat: isolate private Ability results`.

## Task 10: Connect agent tools, desktop lifecycle, and voice

**Files:** Create `src/server/abilities/tools.ts`, `tests/abilities/agent.test.ts`, `tests/desktop/abilities-lifecycle.test.ts`; modify `src/server/{dot-agent,platform}.ts`, `src/desktop/{main,workspace-preload,chat-preload}.ts`, `src/desktop/host/{workspace-window,workspace-backend}.ts`, and `src/server/local-voice/delegation.ts` only where routing needs it.

**Interfaces:** `abilityTools(service: AbilityService, dotId: string, threadId: string, check: () => void | Promise<void>, signal: AbortSignal)` returns the existing TanStack server-tool definitions. Host lifecycle exposes `attach(connection): Promise<void>`, `suspend(): Promise<void>`, `stop(): Promise<void>` on the desktop controller created by this task. Tool names include source identity via a stable bounded namespace; model arguments never include host authority.

- [ ] Test enabled Dot A/disabled Dot B, revoked mid-turn fingerprint, spoofed digest, namespace collisions, user cancellation, duplicate delivery, and absence of repeated approval prompts for granted tools. Verify normal window close keeps the host attached, app quit/crash stops workers, and an externally managed backend remains running. A headless or unsupported host exposes a clear unavailable state, not an executable tool.
      The attached-backend case asserts `expect(workerPidsAlive).toEqual([])` and `expect(externalBackendAlive).toBe(true)` after app quit, with both values observed independently.
- [ ] Run `npm test -- tests/abilities/agent.test.ts tests/desktop/abilities-lifecycle.test.ts tests/voice-delegation-coordinator.test.ts`; expect RED.
- [ ] Wire tool dispatch into the current agent loop and grant fingerprint checks. Expose no special bypass for voice. Connect trusted IPC sender checks to bundled workspace/chat surfaces; a remote renderer cannot install, connect accounts, or read owner-only results. Stop Ability admission and wait for worker cleanup before existing desktop/backend teardown, workspace switch, suspend/lock, and storage maintenance. Resume requires fresh session revalidation. Native watchdog handles hard desktop death independently.
- [ ] Rerun tests plus real launcher parent-death acceptance for an attached-backend fixture. Commit: `feat: integrate Abilities with Dot sessions`.

## Task 11: Teach an Ability and show its results

**Files:** Create `src/client/abilities/{AbilitiesSection,PermissionReview,AbilityResultCard}.tsx`, `src/client/abilities/abilities.css`, `tests/abilities/ui.test.tsx`, `tests/abilities/privacy.test.ts`; modify `src/client/{DotConfiguration,ChatTranscript}.tsx`, `src/client/workspace-bridge.d.ts`, and relevant chat bridge declarations.

**Interfaces:** `AbilitiesSection({ dotId }: { dotId: string })`; `PermissionReview({ review, onTeach, onCancel })` with Task 2 review type and async callbacks; `AbilityResultCard({ dotId, handle }: { dotId: string; handle: string })` reads only trusted desktop IPC. No package-authored React/HTML is loaded.

- [ ] Test source/version/selected-Dot/runtime/access shown before Teach; consent mismatch on update; existing package requires another Dot's consent; client ID/setup link/account connection; keyboard and screen-reader controls; disabled/setup-needed/ready/running/blocked states. Assert only one submit is accepted during install and errors preserve input.
- [ ] Write a privacy regression through the actual agent, persisted event collector, memory/compaction projection and voice-delivery inputs. Assert `expect(JSON.stringify(capturedInferenceAndStorage)).not.toContain('SPOTIFY_SENTINEL')` for successful, failed, streaming, interrupted, and late results; the trusted card still displays that sentinel as escaped text. Locally constructed test captures must intercept actual sinks, not mock away the projection being tested.
- [ ] Run `npm test -- tests/abilities/ui.test.tsx tests/abilities/privacy.test.ts`; expect RED.
- [ ] Implement the minimal selected-Dot settings section and transient result cards. Include private runtime path selection only for Python packages needing it. Treat “select result” as a target choice rather than another permission approval. Expired cards explain that the result needs refreshing; do not persist hidden metadata in messages or DOM-derived model context. Use clear host-generated access summaries next to author explanations.
- [ ] Rerun tests and inspect the desktop UI at ordinary and narrow widths, including keyboard navigation. Commit: `feat: teach and manage Dot Abilities`.

## Task 12: Preserve data without restoring execution authority

**Files:** Create `src/server/storage/ability-snapshot.ts`, `tests/storage/abilities-portability.test.ts`; modify `src/server/storage/{unified-snapshot,legacy-snapshot,restore-sqlite,portable-binding,workspace-move}.ts`, `src/shared/storage-archive.ts`, and `src/desktop/host/storage-controller.ts` at existing storage maintenance hooks.

**Interfaces:** `captureAbilityState(workspaceRoot: string, destination: string, signal: AbortSignal): Promise<AbilitySnapshot>` and `restoreAbilityState(snapshot: AbilitySnapshot, workspaceRoot: string, signal: AbortSignal): Promise<void>`; define the versioned nonsecret snapshot shape in `ability-snapshot.ts`. Captures run only while the existing storage gate has stopped Ability writes. Restore uses manifest/path validation and leaves every binding disabled.

- [ ] Test old archives without Ability data; new archives with package records/manifests/private state; exclusion of credentials and owner-result memory; restored packages requiring digest verification and new consent; interrupted move/restore; mixed versions and Dot deletion. Assert backup remains coherent while an invocation was writing state and that no old receipt causes replay after restart.
      Assert `expect(restoredBindings.every((binding) => !binding.enabled)).toBe(true)` and `expect(archiveEntries.map((entry) => entry.path).sort()).toEqual(expectedNonsecretPaths)` using the decoded archive and reopened repository. The fixture includes a sibling credential directory so accidental inclusion is observable.
- [ ] Run `npm test -- tests/storage/abilities-portability.test.ts tests/storage/archive.test.ts tests/storage/workspace-move.test.ts`; expect RED.
- [ ] Extend portable archive inventory/restore compatibility deliberately. Preserve records and private state, not executable trust; reinstall or verify immutable packages before approval. Stop workers before move/capture/restore and use canonical roots afterwards. Disable bindings and invalidate revisions on host change/restore. Forget/last-uninstall remove only unreferenced packages; require the explicit erase-state choice. If a removed Dot has cleanup pending while desktop is absent, persist a cleanup tombstone and finish it before its credential/state could be accessed again.
- [ ] Rerun storage tests across supported archive schema versions; verify rollback does not reactivate grants. Commit: `feat: preserve Ability data across storage changes`.

## Task 13: Package, document, and verify the complete host

**Files:** Modify `scripts/{build-desktop,desktop-runtime,sign-desktop}.mjs`, `.github/workflows/ci.yml`, `package.json`, `README.md`, `docs/desktop/README.md`; extend `docs/abilities/authoring.md`, `docs/desktop/abilities-verification.md`; create `scripts/abilities/smoke.mjs`, `tests/desktop/abilities-packaging.test.ts`, and sealed JavaScript/Python/native fixture artifacts generated during tests.

**Interfaces:** `node scripts/abilities/smoke.mjs --workspace <temporary-directory> --artifact <sealed-package>` drives the same installer/host boundary as production and never reads the owner's workspace. Add `npm run abilities:acceptance` to run the native and sealed-artifact suites with explicit unsupported-platform failure in the dedicated macOS job.

- [ ] Add a packaging test that fails if the launcher, public contract, worker assets, or production runtime are absent, or if a source-checkout path is required. Test installation and invocation of three independently authored fixture packages through the packaged desktop host.
      Assert `expect(verifiedRuntimes.sort()).toEqual(['native', 'node', 'python'])` in the smoke report and `expect(bundleFiles).not.toContain('dev-source.json')`; run the copied bundle from an unrelated temporary cwd with no development configuration.
- [ ] Run the targeted packaging/smoke checks and confirm RED before adding missing assets and wiring.
- [ ] Bundle and sign the launcher through the existing desktop build. Add a macOS CI acceptance job using a concrete verified runner/runtime architecture; preserve existing Linux checks and required check names. Pin/review any newly introduced action revision before use. Add no credentials/models/accounts to CI. Document the public protocol, dependency bundling, helper API, permission evolution, supported platforms, Python prerequisites, unsupported desktop APIs, and current verification limits. Record dependency review findings before any unfamiliar package is executed.
- [ ] Run the full existing CI commands: `npm run check-format`, `npm run lint`, `npm run typecheck`, `npm test` with a dedicated test database, both existing Python voice protocol checks, and `npm run build`. Then run `npm run abilities:acceptance`, `npm run desktop:build`, `npm run desktop:package`, the sealed-artifact smoke and visual checks. Record exact commands, commits and actual outcomes; mark unavailable platform/live checks explicitly. Obtain a whole-branch review and resolve findings before reporting ready.
- [ ] Update the parent MyOwnStack README with implemented versus verified boundaries. Commit: `feat: package and verify Ability support`. Push and verify push checks before opening the host PR; verify PR checks at its current SHA. Do not merge or publish based only on a Linux success or a mock sandbox.

## Handoff to Spotify

After Task 13 passes, freeze the exported API/schema fixtures at the tested host commit and run the separate Spotify plan. A Spotify implementation may be developed against mocks after Task 2, but it cannot be called installable until host acceptance and packaged integration pass. Keep release publication and real Spotify account tests clearly separated from source completion.

## Plan self-review

- Contract, consent, sealed installation, all three runtimes, private state, OAuth, per-Dot grants, updates, shutdown, desktop attachment, chat/voice, owner-only results, portability, and publication boundaries map to Tasks 1–13.
- Each trust boundary has a failing-test step and independent verification; real OS enforcement is checked before higher-level fixtures.
- Cross-task interfaces are defined at their producing task; token-bearing interfaces remain desktop-private. No new SDK package or inference provider is introduced.
- The five Review Focus conditions are covered by explicit task tests. Execution method and this written plan still require owner review before product implementation.
