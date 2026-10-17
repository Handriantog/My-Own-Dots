# Desktop companion verification

Machine: Apple M3 Max, 14 CPU cores, 36 GiB RAM, macOS 26.6.2 (25G83), arm64. Runtime: Electron 44.8.0, PixiJS 8.22.0. Native helper compiled with the installed Swift toolchain, deployment target macOS 14.

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

This local arm64 artifact is not a notarized public release. Intel, macOS versions other than 26.6.2, Windows, Linux, assistant chat/voice/tasks, and sound refinement are outside the verified delivery.
