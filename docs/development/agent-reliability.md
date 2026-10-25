# Dot reliability requirements and development rules

25 October 2026. Owner-confirmed product requirements and ongoing engineering rules following the [postmortem](../postmortems/2026-10-25-agent-reliability.md). The Codex-first design is approved and implemented as a test candidate; the [qualification record](codex-execution-qualification.md) distinguishes verified behavior from remaining acceptance work.

## Product baseline confirmed by the owner

Dot is a companion the owner can call and assign work to by voice, with enough context and execution reliability to trust its progress and results. High local conversation is central to that vision. A temporary experimental status must not become an excuse to deprioritize it or require typing to complete ordinary tasks.

Before unrelated feature expansion, stabilize these three capabilities:

1. **Folder permissions:** identify which project folder a task actually needs, explain the requested access, preserve a replacement chosen by the owner, and complete approval reliably. A parent stack directory, app data directory and source repository are not interchangeable. When evidence cannot identify the project, ask one concrete clarification instead of inventing a path.
2. **Installed Abilities:** consistently discover and invoke enabled, authorized Abilities, explain missing prerequisites, observe results, support follow-ups and stop requests, and recover without duplicate effects. Installation is not proof of compatibility or readiness. An incompatible package, unavailable service or OS denial must produce a useful explanation rather than a false success.
3. **Project debugging:** explain runtime failure, inspect an approved source folder, reproduce a problem, edit code and run tests, including for Dot itself. Report the patch, validation and unresolved limits. Reading files alone does not satisfy this requirement.

These requirements apply through voice and text. They express the product goal; no arbitrary package or task can be guaranteed to succeed under every environment. Reliable behavior includes accurately reporting a block and helping resolve it. A capability is supported only for the combinations of package, version, operating system and prerequisites that we have established.

### Local speech and existing subscriptions

The owner confirmed that speech must stay local because the companion must not require subscriptions beyond the AI subscription a user already has. Speech recognition and generation therefore run on the user's device. Task reasoning may use a supported existing subscription; this is not a requirement that all reasoning work offline.

Do not introduce a required cloud speech service, separately billed inference API or automatic paid fallback. If local models are missing, the network is unavailable or the subscription allowance is exhausted, explain the blocker and preserve task state. Do not silently purchase credits or imply that subscription access is unlimited. Local model downloads, hardware capacity, latency and battery use remain engineering constraints to measure.

Acceptance must eventually include local recognition and synthesis with external network access denied after model setup, plus failure cases proving that unavailable speech or subscription inference does not trigger a paid fallback. The Codex execution candidate includes network-denied synthetic ASR/TTS checks and explicit no-API-fallback policy tests; real microphone, speaker and OS-consent acceptance remain separate.

The owner selected **Codex first** for the new execution layer, with other providers deferred until they pass equivalent checks, and approved the [Codex-first voice design](../architecture/2026-10-25-codex-voice-design.md). The owner requested a tradeoff explanation before implementation. Official documentation distinguishes ChatGPT subscription authentication from usage-based API authentication. Its App Server documentation describes local authentication support and also marks the app-server command experimental; compatibility, permissions, recovery and latency need validation against a pinned installed version before adoption. This finding does not establish equivalent support for every provider or deployment model. [Authentication](https://learn.chatgpt.com/docs/auth), [App Server](https://learn.chatgpt.com/docs/app-server).

## Required acceptance journeys

Implementers translate these journeys into reproducible checks before changing the affected behavior. Use disposable projects, test accounts and dedicated storage; do not experiment on owner application data.

| Journey                                  | Required outcome and recovery                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identify and approve a project           | Match the intended repository using known project context; show the actual path and read/edit scope. Changing the folder changes the eventual grant. Deny, cancel, polling, stale cards and restart do not grant a different path or repeatedly request the abandoned path. |
| Invoke an Ability by text and High voice | Both requests reach the same authorized action semantics. Test a normal request, paraphrase, referenced follow-up and stop. Check observable effect, not just a returned success field.                                                                                     |
| Ability lifecycle and prerequisites      | Cover install/enable/assignment, missing permission/helper, timeout, disable/revoke, update and restart. State whether an action failed, is still running, stopped or has an uncertain effect. Do not silently retry a mutation.                                            |
| Multi-turn continuity                    | Switch between spoken and typed follow-ups; reference an earlier result; correct the target; continue after delegated work completes. Preserve task identity, relevant context and approval state.                                                                          |
| Debug a disposable project               | Starting from a reproducible failure, inspect the intended checkout, propose/apply an authorized patch and run meaningful tests. Preserve unrelated changes. Missing dependencies or test infrastructure are reported, not counted as a fix.                                |
| Debug Dot itself                         | Work in the repository's project-local worktree and use isolated test data. Produce a reviewable patch and tested candidate. Replacing or restarting the running app is a separate lifecycle step; keep a recovery route if the agent is broken.                            |
| Interrupted work                         | Disconnect, cancel, restart or change a grant while work is active. Reconcile recorded state and actual effects before resuming. No duplicate action, stale approval or invented completion.                                                                                |
| Packaged handoff                         | Verify the exact app's prerequisites, affected journeys and clean shutdown. Recheck after rebuilding or permission identity changes. A source test cannot stand in for this.                                                                                                |

## Rules for every future change

**Define the outcome first.** Name the affected journey, observable completion condition, failure states and regression risk. The implementation owner writes and runs the checks. The product owner decides priorities and material product tradeoffs; discovering basic execution failures must not routinely be delegated to owner acceptance.

**Use one authoritative task state.** Voice, text and workers may be separate components, but they must agree on task identity, project, permission, progress and outcome. Keep accepted, started, waiting for approval, completed, failed, canceled and uncertain states distinguishable. Only claim an external effect with evidence appropriate to that effect. Activity status must be fresh, not an earlier start receipt.

**Make failure diagnosable.** Return the missing prerequisite and recovery step when known. Correlate task, approval and tool events across boundaries; distinguish current health from old receipts. Keep traces bounded and avoid credentials and unnecessary conversation content. If the exact cause is unknown, say so.

**Test the boundary that failed.** Add a focused regression and an integration check where the defect crosses native processes, persistence, approvals or provider sessions. Mocks need realistic lifecycle semantics. Use held-out paraphrases and multi-turn cases for behavioral evaluations; never report a prompt-tuning set as general accuracy. Keep task success, false-completion claims, interruption/recovery and latency as separate measurements.

**Control context and time budgets.** Assess new tool definitions and instructions against a realistic installed catalog and long conversation. A coding task needs an appropriate resumable execution budget; raising a timeout or context cap alone does not establish recovery or quality.

**Verify the candidate that is handed over.** Record commit plus any uncommitted patch identity, exact app location/build identity, relevant model/runtime and Ability versions, storage mode, prerequisite status, check results, and a known recovery build. Re-run affected checks after the final relevant change. Do not recycle results from another worktree, old package or earlier revision.

**Keep acceptance honest.** Agree on evaluation inputs, repetitions and thresholds before running them. The acceptance set must contain no unauthorized action or false-completion claim. This is a gate on observed cases, not a universal guarantee. Thresholds for task completion, response latency and recovery still need measurement and agreement; no invented reliability percentage is approved here. Failed or missing evidence stays visible. If a failure repeats at the same boundary, review the contract/design before choosing another local patch.

## Automation implemented in this worktree

The existing CI checks now share their entry points with local development:

```sh
# Complete setup first; export LOCAL_TEST_DATABASE_URL for a disposable test DB.
npm run verify:core

# Requires macOS arm64 and the existing native fixture prerequisites.
npm run verify:macos
```

`verify:core` runs formatting, lint, types, the full test suite, both speech-worker protocol suites and the web/server build. It rejects a missing test URL before tests can silently skip database coverage. It requires a PostgreSQL URL with a `test` or `tests` name segment (for example `dots_test`), disallows URL query overrides, and rejects a known application database with the same host/port/database even when credentials differ. The caller must provision dedicated storage: a name check cannot prove a database contains no owner data, detect every DNS alias, or discover application settings not supplied in the environment. It does not load the owner's `.env` or create/start/delete databases.

`verify:macos` runs the existing native Ability acceptance, desktop packaging and relocated package smoke. Unsupported platforms fail instead of becoming a passing skip. Both commands stop on the first failed or unstartable check. Dependency/runtime setup remains in CI and the existing setup instructions; these commands do not install packages.

The [CI workflow](../../.github/workflows/ci.yml) invokes those same profiles. The [PR template](../../.github/pull_request_template.md) asks for user-journey evidence, exact candidate, remaining gaps and current push/PR checks. These repository changes take effect for other branches after integration; editing this worktree does not alter already-running sessions or GitHub branch protection.

These are automated component/integration gates. They do not automate real voice quality, physical cursor movement, OS consent or project-debugging acceptance. A passing profile alone does not establish that Dot is reliable.

The first workflow-only checkpoint had incomplete database coverage. Later full profiles used a dedicated test database and passed; that earlier partial run is historical evidence, not the current gate. The [qualification record](codex-execution-qualification.md) records the tested candidates and retained failures. Before a PR, rerun the profiles on the proposed tree and check both push and pull-request Actions for the final commit.

## Implemented baseline and remaining work

The Codex execution adapter, explicit project execution grants, durable voice inputs, bounded diagnostics, build identity, native failure tests and live journey scripts are implemented. The current qualification uses an exact vendored Integrator package with reproducible source provenance. Local handoff manifests and owner recovery copies are deliberately ignored; portable conclusions and reproduction commands belong in these committed guides.

Still open: a fully automated aggregate handoff verifier, broader held-out speech/coding evaluation, a published per-Ability compatibility matrix, latency targets, long-call behavior, expressive local speech and High voice selection. Local speech, no additional subscription and Codex-first are settled. Do not reopen those decisions merely because a new agent lacks the conversation history. Other providers and automatic self-deployment remain deferred.

## Stabilization order

First establish correct project identity, permission handling and truthful action state. Then use those contracts for Ability execution and the coding engine, with High voice included in every acceptance run. Prove one complete voice-driven debugging journey before expanding the supported surface. Use the same release gates for all later features.

The owner approved this architecture and implementation. Voice remains part of each execution milestone; unrelated features wait for the stabilization baseline.

## Rules added from implementation evidence

- Exhaustively type-check the storage worker registry against asynchronous repository methods. A missing registration caused a real Promise-cloning failure despite source unit tests passing.
- Keep durable voice input outside a busy parent conversation lease; gate conversion and cancellation in one storage transaction. An acknowledgement is never permission to drop a request when another queue is full.
- Resolve authorized predecessor results at execution admission. Capturing context before a queued task waits loses mixed-channel follow-ups.
- Bind pending approval to the host-selected engine version. A host status/receipt run preserves that identity; switching engines requires a fresh request instead of silently resuming old authority.
- Test speech cancellation through the actual child process. Output interruption suppresses stale playback while safe synthesis drains; it does not kill recognition for the next utterance or retry work.
- Bound and validate generated audio, then stress exact technical text. Character limits did not prevent the generative decoder from missing its audio terminator. The Codex candidate uses installed macOS Samantha TTS, explicitly, inside the offline sandbox. Legacy local conversational speech remains a separate experimental path.
- Build an immutable identity into the packaged runtime. Diagnostics expose source SHA-256, base commit, modification state, Integrator integrity and qualified CLI version, so a source fix cannot be confused with the running app.

- Qualify the exact packaged dependency topology, including project-local linked worktrees. Preserve canonical root packages and distinct nested versions; a source-only dependency test can miss cycles in the app packager.
- Use an independent test oracle for coding evaluations. Preserve the check file and record actual failing/passing observations; an assistant summary or missing command event is insufficient evidence.

## Qualification fixture discipline

Bound every external test process, including synthetic speech input generation. Preserve failed attempts and distinguish a fixture that never submitted a request from an agent failure. Serialize shared speech machinery. Require explicit behavioral contracts and positive, negative and boundary checks for debugging tasks; passing a single example is insufficient. Independently inspect answers against observed effects before accepting a live matrix. Publish retests alongside the original result rather than silently replacing failed rows.

The live qualification tool catalog must match the desktop configuration, including optional host callbacks. Ordinary requests build the whole catalog, so an unused tool can still break every turn. A fixture may replace OS effects with explicit failure, but must retain the real tool schema and registration path. Cover serialization and runtime validation separately; model input schemas describe pre-transform inputs, while host parsing still validates and normalizes execution arguments.

### Conversation acceptance

Do not synthesize an admission acknowledgement on every voice turn. Accepted work may use a visual waiting state; speak the actual answer or an actionable blocker. Preserve substantive replies in the call transcript. Test casual conversation as well as actions, including a result arriving during startup, slow completion, interruption and a subsequent turn. Verify the packaged desktop tool catalog. Measure answer latency and audio scheduling separately from provider completion and software playback acknowledgements; those acknowledgements do not prove audibility. Changes to the speech engine require explicit evaluation of expression as well as bounded completion. Never remove permission/revocation enforcement to mask audio scheduling problems.

## Next-agent handoff

Read this guide, the [approved design](../architecture/2026-10-25-codex-voice-design.md), [postmortem](../postmortems/2026-10-25-agent-reliability.md), [qualification](codex-execution-qualification.md) and [dependency provenance](../../vendor/README.md) before changing this boundary. The runtime HTML/SVG maps document the pre-Codex investigation and legacy path; the approved design contains the current Codex flow.

The owner reported the natural-voice correction working in their own test on 25 October 2026. This is qualitative feedback, not a measured guarantee of every Ability or physical-device scenario. The next requested discussion is High voice quality and voice selection, after this PR. No new speech engine or selectable High voice is implemented or selected. The existing voice dropdown belongs to Medium/Kokoro. High/Codex hardcodes Samantha and 180 words per minute; changing the dropdown alone cannot change its speech. Model/effort settings are inherited, so a voice-only change must not silently change global Codex configuration.

| Failure or decision                                                      | Regression or gate to preserve                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong folder and ignored replacement                                     | `tests/folder-access.test.ts`, `tests/desktop/folder-picker.test.ts`, `tests/desktop/folder-approval-window.test.ts`; review exact path and access                                |
| Ability success despite host failure                                     | `tests/abilities/activity-admission.test.ts`, `tests/desktop/abilities-mouse-mover.test.ts`; retain host-owned failure reasons and observe the effect                             |
| Shared runner lost queued voice or predecessor context                   | `tests/native-voice-runtime.test.ts`, `tests/storage/voice-delegations.test.ts`, `tests/codex-dot-context.test.ts`; persist before effects, no automatic replay                   |
| Missing worker RPC method                                                | `tests/storage-worker.test.ts` and the exhaustive `AsyncRepositoryMethod` registry type check                                                                                     |
| Desktop URL transform broke every request                                | `tests/codex-desktop-tools.test.ts`, `tests/codex-agent.test.ts`; input-mode JSON Schema plus strict host parsing and actual desktop catalog                                      |
| Repeated Received, missing answer transcript, startup/interruption races | `tests/native-voice-agent.test.ts`, `tests/native-voice-runtime.test.ts`, `tests/native-voice-live.test.ts`; silent admission, ready worker, revalidate after awaited persistence |
| Speech hangs or dies after interruption                                  | Python native-worker tests plus actual isolated local-worker qualification; bounded synthesis, safe drain, successful next recognition                                            |
| Package differed from source                                             | `tests/desktop/runtime-packaging.test.ts`, `verify:macos`, build identity and exact-package live journeys; never edit installed dependencies as the fix                           |
| Green checks masked a superficial coding repair                          | Explicit positive/negative/boundary contract, unchanged test file, observed failing/passing values, independent semantic review                                                   |
| Software audio counters mistaken for a good conversation                 | Human listening and separate latency/audio-content checks; retain revocation enforcement, do not claim emotion or audibility from PCM counts                                      |

A new voice backend must demonstrate bounded completion, startup, cancellation, mute/interrupt and next-turn recovery, actual saved answer text, offline speech operation and truthful setup failures before replacing Samantha. Keep local speech and shared task authority intact. Per-frame authorization can underfeed audio under slow storage, and the current single pending-update slot has not been redesigned; these are explicit follow-up limits, not reasons to weaken permission checks.
