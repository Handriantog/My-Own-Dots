# Desktop companion verification

Machine: Apple M3 Max, 14 CPU cores, 36 GiB RAM, macOS 26.6.2 (25G83), arm64. Runtime: Electron 44.8.0, PixiJS 8.22.0. Native helper compiled with the installed Swift toolchain, deployment target macOS 14.

## Release verification — October 19

The owner reported that the latest calls no longer showed recognition errors and were more reliable, and requested release PRs. The live recognizer uses a fixed Dot-name hint and one unprompted retry for invalid decoder output; the complete conversation remains available to the governed agent. The installed-model generated-audio check accepted 36/36 clips (33/36 exact words) and rejected the three silence/noise controls. This is not an owner-accent benchmark or a controlled hardware latency measurement. See [recognition reliability checks](local-voice-calls.md#recognition-reliability-checks).

The release switches the dependency from a local candidate archive to npm `myown-llm-integrator@0.2.0`; the installed registry archive matches the verified release checksum. Final checks passed **993 tests with one skipped certificate-identity test**, using a disposable PostgreSQL instance and the published Integrator Python environment, plus **30 Python speech-worker tests**. Formatting, lint, typecheck, web/server and desktop builds passed. These checks used fixture inference and no new microphone, speaker or live-provider session. The npm audit reported the same 13 findings as `main` (7 low, 4 high, 2 critical); the dependency update introduced no new findings. The earlier dated sections below retain their original verification scope and counts.

## Voice latency diagnosis and name recognition — October 18 follow-up

The owner's three logged inference requests took **5,450 / 6,212 / 5,370 ms**, all with `startupMs: 0` and `reusedRuntime: true` (`artifacts/voice-session-workspace.log`). These are the Integrator engine durations, including queueing, provider startup/authentication, generation and validation; they do not isolate model generation or include recognition and playback. Warm Python reuse is active but does not remove the main wait. Current endpointing also waits for 704 ms of silence, and speech follows the completed governed answer.

[OpenAI's ChatGPT Voice documentation](https://learn.chatgpt.com/docs/features/voice) identifies GPT-Live as its voice layer. The [published GPT-Live architecture](https://developers.openai.com/api/docs/guides/live) supports simultaneous listening/speaking and delegated backend work. [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation) could retain Dots' existing backend and application-owned permissions, but would introduce a separate paid cloud voice connection. This is an architectural option, not implemented here or a measurement of proprietary ChatGPT internals. A local/subscription alternative needs a persistent provider adapter and a defined incremental speech contract; the current structured-result API does not supply committed text chunks.

For recognition, a network-denied experiment compared no hint, a bare “Dot” vocabulary hint, and the context “A conversation with an AI assistant named Dot.” using the installed Whisper base and Kokoro. Eighteen generated clips covered greetings, genuine “dad,” “dog,” and a work-folder request in Heart, Michael and Emma voices. The product path failed on two Dot clips before the change; after applying the English context hint it recognized all 18 exactly ignoring case/punctuation. All six genuine “dad” clips retained that word. No post-processing substitution is used. The raw silence decode was unchanged; the real worker protocol check still rejects the invalid silence result as recoverable and accepts the following utterance in the same worker.

- **23 Python tests and 39 targeted voice tests passed.** The product-path generated-audio check and worker protocol check also passed under OS network denial.
- Reproduction and results: `artifacts/local-voice/recognition-name-probe.py --verify-production`, its JSON report, before/after logs, and `recognition-protocol-smoke.json`. Use the installed speech Python under `sandbox-exec -p '(version 1)(allow default)(deny network*)'`.
- No new model, live provider call, microphone recording or speaker playback was used. The running workspace loads this Python source when a new call starts; no desktop rebuild is necessary. Accuracy on the owner's voice remains unmeasured. Further recognition work should compare English-specific models on representative consented recordings before choosing a larger model or changing default downloads.

## Integrator installed in Dots — October 18 follow-up

The owner requested testing the new Integrator package inside Dots. This check used a packed local branch candidate (superseded by npm version 0.2.0 for release), and the owner's `.env` enables `LOCAL_VOICE_INTEGRATOR_SESSION=1`. The optional inference worker warms alongside local speech, is bound only to matching server-issued voice turns and tool continuations, and closes with the call. Typed/background inference still uses `runAgent`; the selected model, prompt construction, scheduler and complete-result validation remain in place.

- Installed-package integration drives `LocalVoiceService` → `DotAgent` → the real packed Integrator → fixture provider. It verifies the same runtime PID across two voice turns and a page-writing tool step, a separate runtime for typed chat during the call, timing metadata without transcript content, and process reaping at call end. Startup cancellation/failure and scope mismatches also pass.
- A network-denied file check used the installed Whisper/Silero/Kokoro workers and the updated package through DotAgent for two complete turns. Both recognized “Hello. Please answer in one short sentence.” and generated a combined 88,222 PCM samples. Both inference steps reported `startupMs: 0` and `reusedRuntime: true`; their fixture inference totals were about 85/87 ms. These are fixture timings, not live subscription latency. Playback acknowledgements were simulated, with no microphone or speakers (`artifacts/local-voice/session-file-smoke.json`).
- Full suite: **931 passed, 20 skipped**. Typecheck, lint and web/server build passed. Review found no remaining session-wiring defect. Inspection also found the prior folder approval absent from local conversation continuation validation; adding it was verified by failing-then-passing message merge and actual LocalAgentRunner continuation regressions, retaining rejection of forged tool results.

The workspace was rebuilt and restarted; readiness returned `ready: true` and `inferenceRuntime: "warm-session"`. The packaged desktop smoke passed against that running workspace with zero renderer errors or microphone attempts; the owner's normal companion remains running. Setting the flag to `0` and restarting restores per-request voice inference for comparison. This remains a small startup-overhead optimization, without provider token streaming or a measured live-call speedup.

## Voice selection and folder approvals — October 18

The three requested changes were implemented and checked sequentially: voice/personality settings, the separate opt-in Integrator session API, then local folder approvals.

- **Voice/personality:** 28 installed English Kokoro voices and four personality profiles persist per Dot. Wording instructions and speech rate/pauses reflect the profile; this is not an emotion-trained speech model. The task's app suite passed 822 tests with 20 skips, and the Python worker suite passed 23 tests. Network-denied file synthesis checked George/Calm, Michael/Cheerful and legacy Heart without playback or new downloads.
- **Integrator:** local branch `feat/voice-latency-api` adds `createAgentSession` without changing `runAgent` or the provider engine. Its check passed 20 Node and 111 Python tests, plus packed consumer and TypeScript checks. Ten alternating network-denied fixture samples measured a roughly 71 ms median warm-start saving. The installed Dots dependency remains unchanged; this does not establish a live voice latency improvement. See the sibling repository's `docs/latency-sessions.md`.
- **Folder approvals:** tests cover request → owner selection → explicit approval → same governed conversation continuation, with a voice approval gate. Read-only is the default; grants are per Dot and revocable. Coverage includes scope and expiry checks, replay after revocation, native gesture/frame validation, helper cleanup, path and file boundaries, stale hashes, overlapping grants and concurrent helper writes. Uncooperative external editors can still race the final hash check and replacement; see [folder access](folder-access.md).
- Final root suite: **924 passed, 20 skipped** across 127 passing and seven skipped files, excluding unrelated worktrees. Typecheck, lint, focused formatting, web/server and desktop builds, and diff checks passed. Independent review's approval-replay and competing-write findings were fixed and rechecked.
- The certificate-signed arm64 package passed strict deep signature and archive checks. Packaged Electron smoke checked the real native folder bridge with a mocked dialog, 28 voice options/four personalities, folder settings, existing chat/menu behavior, voice boundaries and clean shutdown, with no renderer errors or microphone attempts. A separate fixture rendered the actual approval card at 480×720, checked choice versus approval separation and continuation, and its screenshot was visually inspected.

These checks used temporary folders, generated file audio, fixture provider replies and mocked native selection. No actual work folder, live subscription inference, microphone or speaker playback was used. The workspace was rebuilt and restarted; physical listening and live provider timing remain owner checks. Screenshots and logs are under `artifacts/desktop/` and `artifacts/task3-*`.

## Voice feedback fixes — October 18

Talk now opens and starts the call directly, including the first use before Chat has loaded. A one-time native gesture bridges asynchronous conversation setup, with no global autoplay policy change. Cancellation/hide/reload revoke pending intent. English is selected explicitly for recognition and added as a server-bound instruction to the existing Dot turn; typed chat is unchanged.

- Reproduced the recognition failure offline: the pinned Whisper runtime returned an 840 ms segment for an 800 ms generated English clip, causing the previous strict validation to end the call. A bounded 200 ms end-timestamp margin now clamps to the actual input duration; segments entirely outside input and larger anomalies never become user messages. A real worker protocol check accepted the short clip, rejected a silence hallucination as recoverable, then successfully transcribed another clip without restarting (`artifacts/local-voice/recognition-protocol-smoke.json`).
- Unreadable utterances now show repeat guidance while listening continues. One supervised recognizer replacement per call handles a failed process; tests cover cancellation during warmup, no duplicate turns, and preservation of VAD/TTS. A transient readiness poll failure does not revoke a healthy call.
- Immediate canonical-answer notification removes the 0–500 ms browser poll wait (325 ms in the deterministic regression). Sentence-aware TTS and one-chunk prefetch preserve the same model, voice, rate and answer text. Three warm file-only samples measured first PCM at **404–411 ms** for the complete first sentence versus **2381–2416 ms** for the previous 254-character first chunk (`artifacts/local-voice/tts-sentence-prefetch-2026-10-18/report.json`). These are TTS-boundary measurements, not end-to-end or listening-quality results; the subscription response remains buffered.
- Full root suite: **800 passed, 20 skipped**. The final integrated output/cancellation selection passed **32 tests**, including the additional VAD barge-in/prefetch accounting regression. Python worker suite: **19 passed**. Typecheck, lint, formatting, web/server build, desktop build, signed packaging and signature verification passed.
- Native Electron smoke verified direct Talk gesture activation and once-only consumption with **zero microphone attempts**, existing permission checks, and clean shutdown (`artifacts/desktop/chat-smoke.json`). The full network-denied VAD → English Whisper → fixture answer → sentence-scheduled Kokoro file call passed; ACKs were simulated. No live microphone, physical playback or subscription inference was used by the agent.
- The workspace was restarted and reported local voice ready; the certificate-signed updated companion was launched. Owner listening and real conversation timing remain to be assessed.

## Local voice calls — October 18

The [call implementation](local-voice-calls.md) now connects local speech to the existing interactive chat agent and its approval cards. The following sections retain evidence from earlier stages; their disabled-Talk statements describe those earlier builds.

- Root suite: **763 passed, 20 skipped**. The final server/Chat regression selection passed **42 tests**; Python worker suite passed **16 tests**. Typecheck, server compilation, lint, formatting, web build, desktop build and certificate package verification passed.
- Owner approved the additional Silero model download: **2,327,524 bytes**, pinned SHA-256 verified. No new runtime packages were installed.
- Network-denied file call exercised the real VAD → Whisper → fixture canonical answer → Kokoro path. It recognized “Hello. Please answer in one short sentence.” and generated **67,168 samples / 70 frames** of reply PCM. The foreground reservation released once. Playback ACKs in this check were simulated; no microphone, speaker, or live provider was used (`artifacts/local-voice/live-file-smoke.json`).
- Chromium 153 exercised the production worklet URL and CSP with a synthetic 48 kHz WebAudio stream converted to 16 kHz frames. Natural software playback ACKs, generation flush, explicit reacquisition and track/context cleanup passed. Chromium's native fake-device acquisition remained pending in this environment; that path is not counted as passed (`artifacts/local-voice/browser-audio-smoke.json`).
- Native Electron smoke passed queued Talk intent, readiness, microphone denial outside a call, camera denial, forged-frame denial, hidden-window denial, stop acknowledgement, and clean shutdown. It made **zero microphone acquisition attempts** (`artifacts/desktop/chat-smoke.json`). Call previews were inspected at 440×620, 360×420 and 320×420; short-window controls were adjusted.
- Review regressions cover stale/current canonical run ownership, approval payload exclusion, rapid barge-in, duplicate transcripts and answer polls, mute races, startup cancellation, bounded recognition/output queues, capability expiry, and stalled SSE cleanup. Review also corrected silent paid-voice fallback during readiness failure.
- The workspace was rebuilt/restarted with local voice enabled, and its readiness endpoint returned `ready: true`. The arm64 app was rebuilt with the existing Developer ID identity, its microphone purpose text and signature verified, and the updated companion launched.

Real microphone permission, echo behavior, audible playback, physical interruption latency, live subscription continuity and sustained call quality remain permissioned hardware checks. The companion is ready for the owner to start those checks; none is claimed by the fixture results.

## Local voice feasibility — October 18

The [prototype record](local-voice-prototype.md) reconciles the voice brief with the active root desktop/chat work. Installed Integrator 0.1.0, the subscription adapter and headless turn API remain buffered. Real subprocess and SDK fixtures verify complete validation before speech, cancellation cleanup and no partial/failed-turn leakage.

- Root suite: **654 passed, 20 skipped**; **10 Python worker tests passed**; typecheck, server NodeNext check, lint and targeted formatting passed.
- A disposable workspace/database completed two fixture speech turns through the real Platform, including a server tool and restored history after runtime restart.
- After explicit owner consent, **544,166,265 bytes** of pinned models/wheels were downloaded and hash verified; the dedicated installation uses about **700 MB** of disk.
- Real multilingual Whisper base/Kokoro file-audio pipeline passed two turns with fixture reasoning. Cold warmup: **13.25 s**. File-end to generated PCM: **1.72 / 1.20 s**. English recognition omitted “Dot” from the synthetic input phrase; Indonesian and listening quality remain unverified.
- Speech also passed under macOS network denial. Cancelling active synthesis reaped the worker in **10.7 ms**, one software-only observation. These timings are neither audible latency nor live-subscription measurements.
- No microphone, speaker playback or live provider was used. Talk remains gated; the running desktop was not rebuilt/restarted. Cleanup left no speech worker or disposable prototype database.

## Menu spacing, stationary Dot, and matching chat avatar — October 18

Clouds are 112×58 logical pixels with the side choices raised closer to the top choice. An explicit simulation freeze keeps the root stationary while the menu is open; ordinary roaming pause previously still allowed deceleration, falling, climbing, and support movement. Closing the menu restores normal simulation, and body pickup dismisses it first.

Desktop chat now renders the same plush rig with the current body color in both its welcome view and conversation header. Appearance travels as validated color data in the local workspace URL, and host updates preserve drafts and reload state without exposing desktop IPC to the workspace. The renderer uses the desktop's CSP-compatible Pixi setup.

- Current-checkout suite: **632 passed, 20 skipped**; lint, typecheck, web and desktop builds passed.
- Added regression checks for frozen walking/falling/climbing, lost support, resumption, and companion versus specialist avatar selection.
- Production Electron smoke passed with a non-default pink preference: stationary open menu, rendered matching avatar, reload, color refresh, reopening with host color, preserved draft, Chat/Hide/Escape, offline recovery, and isolation. Rendered menu and pink chat screenshots were visually inspected.
- Review caught missing CSP initialization and a navigation-time color race; both are corrected. Appearance subscription also reconciles changes between render and subscription.

## Compact surrounding menu — October 18

Clouds are now 100×52 logical pixels (previously 202×96), with Chat left, Talk above, and Hide right. Placement uses Dot's feet and the full display bounds so the Dock work area does not push floor menus away. Near sides/corners the arc folds into the available space. Pointer input passes through the transparent center; another body press dismisses the menu and preserves pickup.

- Current-checkout suite: **626 passed, 20 skipped**; typecheck, lint, and desktop build passed.
- New geometry coverage checks floor, ceiling, corners, negative display coordinates, and non-overlapping body/bubbles. Host coverage checks center click-through and dismissal without reopening on release.
- Electron chat/menu smoke passed: Chat, disabled Talk, Hide, Escape, offline recovery, isolation, and window reuse. Production menu/rig previews were visually inspected at actual scale, including the corner layout (`compact-menu.png`, `compact-menu-corner.png`).
- Independent review found no actionable issues. Automated smoke drives the trusted pointer path; physical pointer/Spaces checks remain separate.

## Cloud menu refinement — October 18

The native popup is replaced by three separate SVG cloud speech bubbles in one transparent, sandboxed menu window. The panel flips to the other side at screen edges, pauses roaming while open, supports arrow keys and Escape, closes on blur, and rejects actions from other frames. Talk remains unavailable. Reduced motion disables the staggered opening animation. Local connection and desktop workspace loading screens now use a neutral speech symbol instead of the fixed blue mascot; the loaded workspace retains its own specialist avatar.

- Current-checkout suite: **616 passed, 20 skipped** across 98 passing and seven skipped files; typecheck, lint, and both builds passed.
- Cloud-menu tests cover trusted sender/action validation, focus-loss dismissal, reuse, and cancellation during loading. Existing host tests still cover click versus pickup and Hide/Show recovery.
- Electron smoke verifies three rendered clouds, unavailable Talk, Escape, Hide, Chat, renderer isolation, and close/reopen reuse. The transparent cloud-menu screenshot was visually inspected at its actual 248×306 logical-pixel size.
- Independent code review found no substantive issues. Physical pointer and Spaces checks remain separate from the automated pointer-path smoke.

## Companion menu and chat — October 18

Body clicks now open a native floating Chat/Talk/Hide menu. Tests exercise the host click path, pickup suppression, duplicate release suppression, cancellation, Hide/Show recovery, multi-monitor panel placement, signed-zero normalization, and loopback address validation. Talk is disabled; this step is text chat.

The compact chat uses the existing workspace app, provider configuration, persistent conversations, and tool approval renderers. The desktop process never receives provider credentials. Its connection page has a restricted preload, while the workspace page has no desktop bridge or Node access. Closing the chat hides and reuses the window.

- Current-checkout suite: **613 passed, 20 skipped** across 97 passing and seven skipped files. Typecheck and lint pass. Existing Vite configuration and large-bundle warnings remain.
- The unfiltered `npm test` also discovered other local worktrees: 2,128 tests passed, but `.worktrees/command-center/tests/local-setup.test.ts` failed its `.env` mode expectation (0644 versus 0600). The current-checkout result above uses `--exclude '**/.worktrees/**'`; that unrelated worktree was not changed.
- The Electron chat smoke opened the native menu through the trusted pointer path, confirmed the disabled Talk item, recovered from offline and API-only servers, checked the compact layout and renderer isolation, rejected duplicate window creation, and verified close/reopen reuse. Reports/screenshots are under `artifacts/desktop/`.
- One real tool-free chat prompt through the configured Codex subscription returned “Desktop chat is connected.” The same response and selected conversation restored after reloading. This verifies the desktop-to-workspace inference path, not every tool or provider.
- The existing companion smoke still passed: all 69 sounds decoded, overlay non-focusing and visible, sandbox intact, second launch reused the instance, preferences persisted, and no renderer errors were reported.

Review reproduced and fixed an overlapping mobile hamburger/scrim and a readiness probe that accepted a running API without its frontend. The smoke now covers both. Physical pointer/Spaces acceptance remains distinct from automated IPC and Electron window-flag checks.

A final regression reproduces locking the screen after geometry invalidation has already hidden the overlay. Chat now hides independently of the overlay's visibility transition. The regression failed before that fix and passed afterward. The app was packaged with the running companion's existing certificate identity; strict deep signature verification and ZIP integrity passed. Both companion and chat smoke tests also passed against the packaged executable. Saved preferences were backed up before the companion restart.

## Accessibility disappearance fix — October 18

The reported status was “Renderer unavailable; choose Recover companion.” The running old ad-hoc app's host, renderer and observer were alive, but the overlay was hidden and its simulation was below the display. Inspector capture and the native error dialog identified `BrowserWindow.setPosition` throwing a conversion error. The captured root x-coordinate was `159.6925468827576`: rounding `root.x - 160` produces JavaScript negative zero. A real Electron 44.8.0 probe confirmed `setPosition(-0, 700)` throws the exact error, while positive zero and negative one succeed. This is a confirmed coordinate-conversion failure; the timing of the Accessibility grant does not establish permission handling as its cause.

All native overlay origins now normalize rounded zero to positive zero, including held/offscreen and display-contained placement. Simulation positions and motion remain unchanged. Regression fixtures include the captured live coordinates and both axes/placement branches. The existing below-screen recovery was observed returning the old instance to its floor after its blocked delivery was resumed; no speculative physics rewrite was made.

A second reproduced bug counted renderer restarts across the whole app lifetime. Three 900 ms renderer stalls spaced 6.5 seconds apart permanently hid the old build. The new build resets the budget after five seconds of valid frame acknowledgements, coalesces duplicate errors during a pending reload, and still stops after consecutive failed recoveries. Manual recovery starts a fresh attempt. The same packaged stall probe now completes all three cycles with a visible companion and a fresh recovery budget each time.

Bounded local diagnostic files record health/status events, renderer errors and recovery reasons. A synchronous last-exception file survives fatal process exit; failed diagnostics I/O does not interrupt Dot. Logs exclude other applications' window titles/content. The menu opens the log directory.

- Full suite with certificate checks: **598 passed, 19 existing skips** across 96 passing and seven skipped files. Typecheck and lint passed; the existing Vite configuration warning remains.
- Regressions failed before the signed-zero/recovery fixes and passed afterward. Independent review found no substantive issue and suggested an additional clamped-origin fixture, which was added.
- Certificate packaging, strict deep signature verification, ZIP integrity, and the packaged smoke test passed. The smoke verified a visible non-focusing panel, all 69 decoded sounds, the sandboxed bridge, single-instance behavior and saved preferences, with no renderer errors.
- Real native negative-zero rejection and repeated packaged recovery are verified. The exact macOS permission transition and physical multi-monitor drag remain owner acceptance checks; no privacy permission was changed by the agent.

The corrected app replaces the old app in the default `release/My Own Dots-darwin-arm64/` location. Earlier bundles are retained as ZIP archives, avoiding several runnable copies with the same bundle ID. User preferences were backed up before replacement. This build uses the stable certificate identity introduced in the preceding feedback pass; the old ad-hoc Accessibility entry may need to be removed and this current app added once.

After replacement, native app inspection visually confirmed the blue plush Dot on the desktop. Its own health log reports the renderer ready, native panel visible, zero recovery attempts and no asset error. Color and volume were preserved. The new identity currently reports Accessibility denied, so window play awaits the owner's renewed grant. No inspector listener remains open.

For PR preparation, the owner subsequently reported the updated app working. The full suite, formatting, lint, typecheck and web production build were rerun successfully. A Linux-platform simulation exposed that the mocked host tests inherited the runner's operating system; their fixture now explicitly models macOS and restores the original platform afterward. All 11 lifecycle tests pass in that simulation. Actual Linux CI remains a separate check, and this does not add Linux companion support.

## October 17 second feedback pass

This pass adds nearby pointer gaze, intentional rubbing/petting with bounded heart bubbles, seated sitting/sleeping, playful look/wave/groom/headphone/ledge-peek actions, and persistent category sound controls. It keeps the existing plush atlas and all 69 sound files. New gestures use continuous pose changes and a bounded noncontact arm speed. Grounded soles stay on their support during peeking and seated transitions.

The climbing blocker was confirmed in macOS `tccd` logs: the responsible application was correctly identified, but its current ad-hoc code hash did not satisfy the older Accessibility grant. Restarting the helper could not repair that grant. Packaging now accepts an explicit certificate identity, signs nested code and the observer inside out, checks each designated requirement, and fails closed if the requested identity is unavailable. Changed temporary certificate-signed apps and observers satisfy each other’s designated requirements. The old Accessibility entry must be removed and the current app added once; this pass does not modify TCC or grant permissions silently.

The Dock’s reserved work-area height previously made a full-width imaginary floor. Floors now use display bounds. A bounded public AXList geometry query supplies a separate Dock perch only while exposed and plausibly dock-shaped. The full-screen Core Graphics Dock backing window is deliberately rejected. Tests cover center landing, drops past both ends, hiding support, side-Dock work areas, and mixed-scale panel containment. New saved positions use display bounds with a backwards-compatible marker; restored points retain their saved display identity at vertically shared floor boundaries.

- Full suite with certificate checks enabled: **590 passed, 19 existing skips** across 95 passing and seven skipped files. The desktop subset has **134 tests**, including the certificate-dependent test (skipped when no identity is configured). Typecheck, lint, and web build pass.
- New regressions were observed failing before fixes for absent category migration/routing, Dock bounds/observation parsing, overlay containment, pointer gaze, petting, seated anatomy, pose continuity, placement restoration, silent voice allocation, and signing support.
- Actual Pixi contact sheet and ten-second interaction motion preview inspected, covering gaze, repeated petting/hearts, sit/sleep transitions, wave, grooming, headphones, and ledge peek. The 22-second walk/climb/pickup preview confirms a successful settled perch. `node scripts/desktop-rig-preview.mjs --interactions` reproduces the new preview.
- Thirty synthetic minutes with 20 scripted windows completed with finite state, maximum root displacement 6.82 logical pixels/frame, 4,561 interaction events, at most two policy voices, and 22.6 MiB final JavaScript heap. Dense occlusion leaves no usable climb tops in that fixture; independent single-window simulation tests and the motion preview exercise climbing.
- An independent review checked all changed/new files. Placement coordinate migration, ambiguous monitor-floor identity, silent voice allocation, and gesture speed findings were reproduced and corrected. See [review resolutions](review.md).

Two physical displays are attached for this pass: built-in 1512×982 at scale 2 and external 1920×1080 at scale 1, offset to `(1512,-43)`. The real helper compiles and reports both displays, nine window rectangles, and denied Accessibility. Native fallback floors are correctly `982` and `1037`. **Trusted live Dock footprint, native climbing after the fresh grant, and physical left-edge flicker remain owner acceptance checks.** Synthetic tests and display inventory are not a claim of physical acceptance.

The reviewed arm64 source was packaged with a certificate identity under `release/certificate-candidate/`; strict deep code-sign verification and ZIP integrity passed. The packaged executable launched from outside the checkout with isolated data, loaded all 69 sounds, kept the ordinary cursor, exposed only its sandboxed bridge, and reported no renderer errors. Its panel was visible, non-focusing, always-on-top, and present on all Spaces by Electron configuration. A second launch yielded correctly and preferences persisted on clean shutdown. These flags are not physical stacking proof. The built settings renderer was exercised with a mocked bridge: category switching retained separate 0%/25% values without changing 40% master volume, all controls remained scrollable, and there was no horizontal overflow or renderer error. The desktop-control tool timed out binding the existing app, so it did not provide live native interaction acceptance. The running older app and its preferences were left untouched; quit it before launching the new build. Earlier sections retain historical measurements and limitations; their counts and single-display inventory do not describe this pass.

## October 17 owner-feedback pass

The menu now says **Customize Dot**. Pickup uses the ordinary pointer, no drawn hand, and a sustained awed face. Walking has a shorter stride, opposite arm swings, and planted soles that remain level during body deformation. Climbing uses a smooth initial reach, repeated planted-palm pulls, mild effort, a secure top destination, and a 2.8-second settling interval. Hops use the gravity-consistent flight duration and an inset destination to avoid overshooting the end of a perch.

The reported external-monitor issue was clarified as flickering between positions on the left side. The former root-centered 320-pixel native window could straddle the display edge; autonomous placement now keeps it inside the active work area. Dragging and partially offscreen recovery retain a root-centered surface so an off-center grab can cross monitors intact. Tests cover negative, vertically offset, and mixed-scale display layouts. **The exact physical flicker is not verified as resolved:** this pass has only the built-in Retina display, and the native helper reports Accessibility false.

- Full suite: **529 passed, 19 existing skips**; desktop subset **73 passed** across ten files. Type checking, lint, web build, and diff whitespace checks pass.
- Regressions were observed failing for edge placement, missing climb destinations, sliding grips, immediate departure after pull-up, long-held expression, overwide gait, abrupt arm contact, stroke clock catch-up, cross-monitor clipping, pause during the first reach, and resuming a paused climb from mid-wall.
- Independent review reproduced three interruption regressions; each was fixed and rechecked. The final review found no remaining important issue in those fixes. See [review resolutions](review.md).
- Thirty synthetic minutes with 20 scripted windows completed: maximum root displacement 6.77 logical pixels/frame, 4,717 interaction events, at most two policy voices, and 26.4 MiB final JavaScript heap. That dense layout has no eligible climb tops; separate single-window tests and the actual-rig preview exercise successful climbs and perches.
- The actual Pixi rig was inspected in a 22-second motion preview, including timestamped walk frames, climbing contact, successful perch, and long-held expression. Reference sources and reproduction command are in [asset notes](asset-notes.md). No source imagery or sound was replaced.

The refined arm64 app and ZIP were rebuilt from implementation commit `bb5a229`. Strict local code-sign verification and archive integrity passed. The packaged executable launched from outside the checkout with isolated preferences, one visible non-focusing always-on-top panel, all 69 sounds decoded, the ordinary cursor, and no renderer errors. A second launch yielded to the first instance, and preferences persisted on clean shutdown. This is a local ad-hoc build, not a notarized release.

The historical measurements below belong to the initial delivery; they are not fresh live-soak measurements for this refinement.

## Initial delivery automated evidence

- Existing baseline before implementation: 456 passed, 19 skipped.
- Final combined suite: **516 passed, 19 existing skips**, across 92 passing and seven skipped test files. The desktop subset has 60 tests across ten files.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed. The existing web bundle retains its large-chunk advisory and Vite's existing extension warning.
- Desktop tests cover protocol bounds/order/staleness/session changes, occluded surfaces, support loss/motion, swept falls, click/drag separation, grip transforms, bounded throw, damped carry, display transfer, long stalls, gait continuity, rig assets/colors/hit areas, corrupt settings, IPC backpressure, helper restart limits, and audio cancellation/mixing.
- The real Swift helper compiled and returned protocol-v1 geometry for the current display and application windows. Accessibility reports **false** on this machine; native window play is therefore correctly gated to floor-only mode.
- `npm run desktop:package` produced a standalone arm64 app and ZIP from implementation commit `152638d`. `codesign --verify --deep --strict` passed for its local ad-hoc signature, and `unzip -tqq` passed for the archive. The ICNS container validates as a 512×512 image. The app contains all 69 sounds and its observer, with no server source or dotenv files.
- The final packaged executable launched with its working directory outside the checkout. It displayed one non-focusing transparent panel, loaded the plush rig, decoded all 69 sounds, and reported no renderer errors. `window.process` and `window.require` are unavailable; preload exposes only the five explicit companion operations. A second launch exited successfully while the first retained its single overlay. Non-default volume, mute, display, and relative placement persisted on clean shutdown.
- The native smoke read `visible=true`, `focusable=false`, `focused=false`, `alwaysOnTop=true`, and `allSpaces=true`. These are configuration observations, not proof of actual stacking over another fullscreen app.

The first launch found Pixi's dynamic-uniform and worker-loading defaults incompatible with the strict CSP. The renderer now uses Pixi's static uniform implementation and main-thread asset decoding. CSP remains without `unsafe-eval`, and workers remain disabled.

A final suite invocation was interrupted by a 704-second macOS maintenance sleep, recorded in `pmset -g log` at 09:17:14–09:28:58. Six existing non-desktop tests consequently hit their timeouts after roughly 702 seconds. The final recorded pass used `caffeinate -i` around the test command only; no test timeouts or persistent power settings were changed. The interrupted log is retained in the local artifacts.

## Motion and visual inspection

`node scripts/desktop-rig-preview.mjs` renders the actual Pixi rig across idle, walking, pickup, climbing, sleep, stretch, fall, sitting, yawn, and click poses, plus five body colors. The final contact sheet was inspected. Hanging foot attachment, outward arm stretch, and pull-up palm contact were corrected. The headphones retain rigid dimensions during body deformation. Arrival fades in, and resting presentation reduces its cadence. Eyes, smile, plush texture, proportions, and cream headphones remain the same master assets. Runtime silhouette masks suppress disconnected atlas debris; source atlas and provenance remain in the repo. The settings page was also rendered and inspected at its intended content size; controls and explanatory text remain visible.

`node --import tsx scripts/desktop-soak.mjs` completed **30 simulated minutes with 20 scripted windows**, at 60 presentation samples/second. It includes moving/removed windows and a permission-loss interval. The final run stayed finite and continuous; maximum root displacement was 10.08 logical pixels in a frame. It generated 3,298 interactions, with at most three policy voices and bounded dedupe history. A separate ten-minute single-window test exercises successful climbing, hanging, pull-up, and subsequent walking. This is virtual-time simulation evidence, not a native 30-minute desktop soak.

The independent whole-branch review found four Important issues. Each was reproduced, fixed, and covered by a regression observed failing before the change and passing afterward. See [review resolutions and decisions](review.md). The final suite also covers stale tracking during capture and the actual rendered palm's contact geometry.

## Native acceptance limits

The desktop-control tool successfully launched a disposable AppKit fixture, and Core Graphics observed all 20 fixture windows. However, the tool returned `cgWindowNotFound` when binding that fixture by path, bundle ID, and name. Finder binding also failed; the macOS tool rejects direct window-ID binding. No permissions were silently granted or security settings changed to work around this.

Consequently these remain **unverified on the actual desktop**:

| Behavior                                                           | Current evidence / next check                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Native pickup, pointer capture and release outside the overlay     | Physics/anchor tests pass; physical input and cursor restoration require an accessible desktop-control session or owner check. |
| Typing focus and transparent click-through                         | Non-focusing panel and hit-area tests pass; type into the disposable fixture while dragging Dot to verify actual routing.      |
| Always-on-top across application switches, Spaces and fullscreen   | Electron flags observed; native composited visibility still needs direct observation.                                          |
| Window standing/climbing while actual apps move, minimize or close | Native geometry and synthetic transitions pass; Accessibility must be enabled before the live interaction matrix can run.      |
| Multiple physical monitors and mixed DPI                           | Negative-coordinate and grip-transfer tests pass; only one Retina display is attached here.                                    |
| Sleep/lock/wake and GPU-loss recovery                              | Lifecycle handlers and deterministic clock/cancellation tests exist; actual OS transitions remain unobserved.                  |
| Visible-to-audible latency and pleasantness                        | Asset decoding and event-policy tests pass; physical output latency is unmeasured. Rough sounds remain explicitly provisional. |

The **final packaged application completed a ten-minute live run** with roaming active, sound muted, and 20 actual fixture windows present. Accessibility remained disabled, so this exercised live floor roaming and native geometry observation, not live window climbing. It produced 119 five-second samples, no renderer/process errors or disconnects, and exited cleanly with code 0 at the scheduled finish. Opening and closing a separate headless preview during this run did not interrupt it.

| Final live measurement                       | Observed result                        |
| -------------------------------------------- | -------------------------------------- |
| Duration                                     | 10.006 minutes                         |
| Sampled renderer JavaScript work, p95        | 0.20 ms                                |
| Summed Electron working sets plus helper RSS | 544.98 MiB first/peak; 508.33 MiB last |
| Sum of Electron-reported CPU percentages     | 1.02 mean; 1.22 p95                    |
| Helper CPU, separately reported by `ps`      | 3.92% mean                             |

Working-set/RSS sums can count shared pages more than once. Electron and `ps` CPU measurements are reported separately rather than added across different measurement methods. JavaScript work does not measure compositor frame delivery, input latency, or physical audio output latency. No universal CPU/memory guarantee is claimed.

Two earlier instrumented runs of the preceding package lost their Playwright target after 35.6 seconds and 8.15 minutes. Neither is counted as a completed soak; their cause remains unestablished. A separate three-minute diagnostic run and the final ten-minute run completed normally. A full 30-minute native soak is therefore **not accepted**; the 30-minute result above is explicitly synthetic. Reports preserve the incomplete-run evidence instead of attributing it to either the app or harness without proof.

The power log places idle sleep at 07:53:56, five seconds after the eight-minute probe's target closed. That timing is useful environmental evidence, but does not by itself establish whether the app, instrumentation, or a preceding OS transition closed the target.

## Reproduce

```sh
npm test -- tests/desktop
npm run typecheck
npm run lint
npm run build
npm run desktop:package
node scripts/desktop-smoke.mjs "release/My Own Dots-darwin-arm64/My Own Dots.app/Contents/MacOS/My Own Dots"
node scripts/desktop-rig-preview.mjs
node --import tsx scripts/desktop-soak.mjs
node scripts/desktop-live-soak.mjs
```

Generated screenshots and JSON reports are under `artifacts/desktop/` (git-ignored). The native fixture source is `native/desktop-observer/qa-windows.swift`; it is deliberately excluded from the shipped application. The app needs neither the fixture nor the source checkout at runtime.

This local arm64 artifact is not a notarized public release. Intel, macOS versions other than 26.6.2, Windows, Linux, live voice hardware acceptance, and sound refinement remain outside the verified delivery. The dated chat and local voice sections above supersede the earlier roaming-only scope.
