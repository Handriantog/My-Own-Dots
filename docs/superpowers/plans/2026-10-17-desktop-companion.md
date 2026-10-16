# Desktop companion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner approved the design and explicitly authorized implementation without another approval checkpoint.

**Goal:** Deliver a locally installable macOS companion: one recolorable plush Dot that explores visible window edges, responds to pinching pickup, and plays the existing interaction sounds.

**Architecture:** A sandboxed Electron overlay presents a host-owned fixed-step simulation. A bundled Swift observer supplies geometry only. Pure TypeScript builds exposed surfaces, manages continuous movement, and schedules identified interactions. PixiJS renders a single layered plush rig; Web Audio consumes the same presentation events. No web server or inference is involved.

**Tech Stack:** Electron 44.8.0, PixiJS 8.22.0, Swift/AppKit/CoreGraphics/ApplicationServices, TypeScript, Vite, esbuild, Vitest, Playwright Electron, @electron/packager.

**Spec:** [Approved desktop companion design](../specs/2026-10-17-desktop-companion-design.md). The owner's subsequent approval supersedes its review-pending status.

## Global Constraints

- One plush character, preserving the existing face, proportions, furry material, and headphones. Color affects body/limbs only. Chat, voice, task integration, multiple pets, and sound refinement are deferred.
- Ambient motion never steals focus or moves other applications. The overlay stays above ordinary and fullscreen applications; system security surfaces are explicitly outside that promise.
- One authoritative global-coordinate simulation, 1/120-second physics, bounded catch-up. Render placement, hit testing, hand anchor, and audio use sequenced presentation frames. No ordinary teleportation or independent renderer physics.
- Actual drag anchor is preserved, including off-center grabs. Threshold 4 logical pixels. Animated pinch hand, localized fur gathering, dangling limbs, bounded damped sway, bounded release velocity. Restore the OS cursor on every exit path.
- Window observation contains geometry/ordering/capability only, no titles or screen contents. Authorization failure, stale observations, and helper failure degrade to honest floor-only mode. Use public APIs only.
- Surface identity includes native owner and lifetime generation. Occluded edges cannot support the body; window interiors are passable. Removed or abruptly moved support causes a fall from the current position.
- Sounds remain provisional. Default volume 40%, at most four voices, deduplication, cooldowns, no immediate variant repeats, canceled fall cue on landing/pickup. Mute and resting are quiet.
- Existing web commands and data remain intact. Runtime needs no external Node, Python, Docker, backend, or network. Local unsigned arm64 app is distinct from a notarized public release; Intel and older macOS support require their own verification.
- Work only in this feature worktree, preserve the user's reference screenshot and unrelated branches. Record native evidence separately from synthetic test coverage.

## Review Focus

1. Stale/helper-restarted/out-of-order observations and recycled native IDs: task 1 protocol tests and task 5 supervision tests must prevent old supports reappearing.
2. Occluded/resized/rapidly moved support while grounded, climbing, paused, or dragging: tasks 2–3 scripted-scene tests must preserve root continuity and detach safely.
3. Pointer capture loss, off-center pickup, negative monitor coordinates, and differing display scales: tasks 3–5 anchor tests plus task 7 native smoke must distinguish simulation evidence from native capture evidence.
4. Long frame stalls, sleep/wake, renderer recovery, and missing displays: tasks 3 and 5 must discard stale work without catch-up or visible ordinary relocation.
5. Packaging from outside the checkout, denied accessibility, missing asset/decode errors, and second launch: tasks 5–7 integration checks must keep controls and floor-only behavior usable and never imply unavailable native capability.

### Task 1: Contracts, native observer, and build foundation

**Files:** Create `src/desktop/shared/contracts.ts`, `src/desktop/core/observations.ts`, `native/desktop-observer/main.swift`, `scripts/build-desktop.mjs`, `tests/desktop/observations.test.ts`; modify `package.json`, `package-lock.json`, `.gitignore`.

**Interfaces:** `GeometrySnapshot` has protocolVersion=1, helperSession, seq, observedAtMs, sceneRevision, pollIntervalMs, accessibility, sceneValid, displays, windows. Displays carry id/bounds/workArea/scaleFactor; windows carry id/ownerPid/generation/bounds/opaque (front to back). `ObservationStream.accept(value, receivedAtMs): GeometrySnapshot | null`, `.current(nowMs): GeometrySnapshot | null`, `.resetSession(): void`. Geometry uses top-left global logical pixels. Events/actions/presentation/preferences types are shared contracts for later tasks.

- [ ] Write protocol tests for malformed/oversized/nonfinite payloads, ordering, sessions, staleness, permission change, and negative display coordinates. Run `npm test -- tests/desktop/observations.test.ts`. Expected: missing module/export failure before implementation.
- [ ] Implement strict bounded validation and receipt-time staleness, rejecting old sessions until supervisor reset. Native helper emits JSON lines, observes AX changes without reading titles, coalesces snapshots, uses CG geometry and public display data, checks authorization without unsolicited prompt, and supports `--once`. Window generations survive visibility changes and invalidate when the process/window disappears. Helper receives `active`/`idle`/`refresh` commands via stdin; process death is supervised later.
- [ ] Add pinned desktop dependencies and native build (macOS deployment target 14, current architecture). Run observer once and inspect metadata/permission state; do not infer permission from optional fields.
- [ ] Run `npm test -- tests/desktop/observations.test.ts`. Expected: all pass. Commit `feat(desktop): add native scene observation`.

### Task 2: Exposed playground surfaces

**Files:** Create `src/desktop/core/world.ts`, `tests/desktop/world.test.ts`.

**Interfaces:** Consumes `GeometrySnapshot`; produces `buildWorld(snapshot, displays, nowMs): World` with `Platform { id, windowKey?, x1, x2, y, displayId }`, `Wall { id, windowKey, x, y1, y2, side, displayId }`, displays and revision. Window keys include owner/id/generation. Floors always derive from current Electron displays; native surfaces only from fresh eligible observations. Body size/foot clearance are shared constants.

- [ ] Write tests: overlapping foreground window subtracts top/side edges and body clearance, narrow/fullscreen-ceiling edges rejected, negative-coordinate display floor, unavailable permission yields floors, ordinary interiors passable. Run `npm test -- tests/desktop/world.test.ts`. Expected: missing world module failure.
- [ ] Implement interval subtraction with small tolerances and usable footprint/body clearance. Clip to active displays; exclude own/helper windows in native adapter and pass explicit owner exclusions. Keep platform identity stable across small moves; segment identity supports contact lookup by window key and projected coordinate.
- [ ] Run `npm test -- tests/desktop`. Expected: all pass. Commit `feat(desktop): model exposed window surfaces`.

### Task 3: Continuous simulation, behavior, and grip

**Files:** Create `src/desktop/core/simulation.ts`, `src/desktop/core/behavior.ts`, `src/desktop/core/pose.ts`, `tests/desktop/simulation.test.ts`, `tests/desktop/pose.test.ts`.

**Interfaces:** `CompanionSimulation` accepts world, seed and optional placement; `setWorld(world)`, `advance(nowMs)`, `pointer(input)`, `setOptions({paused,reducedMotion})`, `suspend()`, `resume(nowMs)`, `frame(): SimulationFrame`. Input is down/move/up/cancel/hover with global point/time; frame contains root, velocity, action, actionAge, facing, support, grip, pose, event queue. `drainEvents(): InteractionEvent[]` clears once. `samplePose(state, dt): RigPose` blends from current values and supplies contact-driven phase and pinch deformation; renderer never decides physics.

- [ ] Write deterministic tests for fast swept landing, one landing event, removed/occluded/moved support, resting support loss, no long-stall catch-up, four-pixel threshold/click exclusivity, off-center grip continuity, bounded throw, damped stationary carry, cross-display drag, unreachable-target rejection, and seeded walk/climb/jump/rest coverage. Write pose continuity/contact tests. Run `npm test -- tests/desktop/simulation.test.ts tests/desktop/pose.test.ts`. Expected: missing implementation failure.
- [ ] Implement fixed steps, swept one-way contacts, contact anchors, bounded accelerations and displacement, deliberate window climbing/pull-up, reachable intentions chosen only at action boundaries, distance-driven gait and secondary pose blending. Keep paused/reduced-motion creature responsive to gravity and drag. Recovery placement is only allowed hidden during lifecycle recovery.
- [ ] Run `npm test -- tests/desktop`. Expected: pass, finite states and bounded movement through long seeded synthetic scenes. Commit `feat(desktop): add continuous creature physics`.

### Task 4: Layered plush rig and pinch artwork

**Files:** Create `public/desktop-dot/` asset package with provenance/rig metadata, `src/desktop/renderer/rig.ts`, `src/desktop/renderer/hand.ts`, `tests/desktop/rig.test.ts`, `docs/desktop/asset-notes.md`.

**Interfaces:** `PlushRig.create(assetBase): Promise<PlushRig>` loads all layers; `update(frame, color): void` positions/deforms only from the supplied pose; `hitTest(globalPoint, frame): boolean` shares the authored silhouette with host hit tests via pure rig geometry. Artwork package contains separate neutral fur torso/limbs, protected face/headphones, source atlas coordinates, pivots, and attach/contact points. Custom vector hand has fingertip origin and open/pinch/release poses. Runtime texture frames are permitted; preserve original generated images and prompt provenance.

- [ ] Inspect existing blue master and derive a transparent layered atlas using built-in image generation; keep identity and hidden anatomy. Do not independently generate per-action frames. Inspect the resulting atlas before using it. Author hand in vector code independently of tint.
- [ ] Write meaningful rig-metadata/pose transform tests for missing layers, protected colors, contact anchor invariance, and bounded deformation. Run `npm test -- tests/desktop/rig.test.ts`. Expected: failing missing rig validation/transform implementation.
- [ ] Implement PixiJS layered sprites/mesh, continuous body/limb deformation, same-master front/side turn, blinking/expressions, pinch fur fold and dangling limb poses; render an action/color contact sheet and inspect it visually. No static-image or primitive final substitution.
- [ ] Run `npm test -- tests/desktop`. Expected: all pass. Commit `feat(desktop): animate the layered plush rig`.

### Task 5: Electron overlay and lifecycle integration

**Files:** Create `src/desktop/main.ts`, `src/desktop/preload.ts`, `src/desktop/host/{helper,preferences,presentation}.ts`, `src/desktop/renderer/{main.ts,index.html,style.css}`, `vite.desktop.config.ts`, `tests/desktop/{preferences,presentation,helper}.test.ts`; extend build scripts and package scripts.

**Interfaces:** Sandboxed preload exposes `onFrame(callback)`, `ack(sequence)`, `pointer(input)`, `ready()`, `reportError(message)` only. Host sends `PresentationFrame` with sequence, timestamp, overlay origin, simulation frame/events, preferences, visibility/cursor status. At most one unacknowledged frame, coalescing newer state while retaining undelivered event IDs. `PreferenceStore` validates versioned settings and atomic writes. `HelperSupervisor` owns a single process/session, bounded exponential retry, and stop/reset. No arbitrary renderer IPC or shell/file access.

- [ ] Write tests for corrupt preferences/atomic replacement, presentation backpressure/event retention, stale-session restart, bounded helper retries and shutdown, sender/coordinate validation. Run corresponding desktop tests. Expected: missing modules failure.
- [ ] Implement nonactivating transparent panel, popup-menu window level, all-Spaces/fullscreen visibility, compact synchronized placement and hit testing refreshed every host tick. Capture drag via native pointer/button observation plus renderer events so leaving the overlay cannot strand a grip. Restore cursor on all lifecycle paths; preload receives no Node capability. Use single-instance lock, bounded helper restart, hidden lock/suspend, fresh-scene wake, renderer-failure recovery, and explicit hidden display-removal arrival.
- [ ] Add tray status, pause, hide/show/recover, tracking settings link/retry, Quit. Keep controls usable on renderer/asset failure. No assistant menu.
- [ ] Run `npm run desktop:build` and desktop tests. Expected: native helper and bundled sandboxed app load locally, tests pass. Inspect app visibility/drag without backend. Commit `feat(desktop): host the macOS companion overlay`.

### Task 6: Sound, customization, and portable bundle

**Files:** Create `src/desktop/core/audio-policy.ts`, `src/desktop/renderer/audio.ts`, `scripts/package-desktop.mjs`, `tests/desktop/audio.test.ts`; modify main/renderer/preferences/rig/build scripts and package scripts; create `docs/desktop/README.md`.

**Interfaces:** `AudioPolicy.offer(event, nowMs): VoiceRequest | null` dedupes/bounds history/cooldowns and chooses no-repeat variants; cancellation scopes and priority limit four simultaneous voices. `CompanionAudio.load(base, manifest)`, `.consume(events, frame, prefs)`, `.suspend()`, `.dispose()`. Preferences carry validated hex color, volume [0,1], muted, paused, reducedMotion, displayId and relative position, never native support IDs.

- [ ] Write tests for duplicate IDs, four-voice cap and priority, cooldowns, nonrepeat variants, fall cancellation on pickup/landing, mute/suspend stale-event discard, and bounded history. Run `npm test -- tests/desktop/audio.test.ts`. Expected: missing implementation failure.
- [ ] Bundle all 69 sounds/manifest, predecode and schedule WebAudio against frame time, fade cancellations, pan gently, surface decode failure without stopping motion. Add tray color swatches/custom picker and volume/mute controls persisted atomically. Respect macOS reduced motion and explicit pause.
- [ ] Package current-architecture standalone `.app` and zip with Electron/helper/assets; keep development/build/web commands separate and document installation, permissions, shortcuts/control behavior and unsigned-release limitation. App resources exclude backend/dev source and secrets.
- [ ] Run `npm test -- tests/desktop` and `npm run desktop:package`. Expected: passing tests, self-contained arm64 app/zip. Commit `feat(desktop): add sounds controls and macOS packaging`.

### Task 7: Native acceptance, soak, documentation, and final review

**Files:** Create `scripts/desktop-smoke.mjs`, `scripts/desktop-soak.mjs`, `docs/desktop/verification.md`; update `README.md`, approved spec status, asset documentation and plan checkboxes. Update ecosystem overview minimally after implementation exists.

**Interfaces:** Smoke launches packaged app using Playwright Electron without relying on source/backend, captures renderer/art evidence, checks single instance, preference persistence, same state sequences, host error handling and helper presence. Soak uses deterministic 20-window scenes for 30 minutes (virtual time allowed only when explicitly labeled) and optionally live Electron resource samples. Native manual matrix remains separately marked observed/unverified.

- [ ] Run all desktop tests plus `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run desktop:build`, and formatting for changed files. Expected: all pass; investigate and distinguish baseline failures.
- [ ] Launch packaged app outside checkout; inspect native capability, controls, transparency, foreground-window focus retention, native pointer drag, pinch/release poses and color identity. Use app-owned test windows for movement/fullscreen where possible; never alter user's documents. Record Spaces/multiple physical monitors and missing permission as unverified when unavailable. Capture action/color evidence and real timings/resources where measurable.
- [ ] Run synthetic 30-minute/20-window soak and live bounded resource observation. Expected: no NaN/unexplained movement, bounded histories/voices, no accumulated simulation time on resume. Report measured scope, not guessed performance targets.
- [ ] Fix discovered issues with reproducing tests. Write exact commands, results, machine/runtime and limitations into verification report. Commit `docs(desktop): record companion validation`.
- [ ] Dispatch the executing-plans fresh whole-branch reviewer with spec, plan, diff package, ledger and Review Focus. Resolve important findings with failing regression tests and full passing suite. Keep local branch/app ready; do not publish or notarize without credentials.
