# Desktop companion verification

Machine: Apple M3 Max, 14 CPU cores, 36 GiB RAM, macOS 26.6.2 (25G83), arm64. Runtime: Electron 44.8.0, PixiJS 8.22.0. Native helper compiled with the installed Swift toolchain, deployment target macOS 14.

## Automated evidence

- Existing baseline before implementation: 456 passed, 19 skipped.
- Combined suite after integration: 504 passed, 19 existing skips. Two additional QA regressions subsequently bring the desktop tests to 50; final combined results are recorded below after review.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed. The existing web bundle retains its large-chunk advisory and Vite's existing extension warning.
- Desktop tests cover protocol bounds/order/staleness/session changes, occluded surfaces, support loss/motion, swept falls, click/drag separation, grip transforms, bounded throw, damped carry, display transfer, long stalls, gait continuity, rig assets/colors/hit areas, corrupt settings, IPC backpressure, helper restart limits, and audio cancellation/mixing.
- The real Swift helper compiled and returned protocol-v1 geometry for the current display and application windows. Accessibility reports **false** on this machine; native window play is therefore correctly gated to floor-only mode.
- `npm run desktop:package` produced a standalone arm64 app and ZIP. `codesign --verify --deep --strict` passed for its local ad-hoc signature. The ICNS container validates as a 512×512 image.
- The packaged executable launched with its working directory outside the checkout. It displayed one non-focusing transparent panel, loaded the plush rig, decoded all 69 sounds, and reported no renderer errors. `window.process` and `window.require` are unavailable; preload exposes only the five explicit companion operations.
- The native smoke read `visible=true`, `focusable=false`, `focused=false`, `alwaysOnTop=true`, and `allSpaces=true`. These are configuration observations, not proof of actual stacking over another fullscreen app.

The first launch found Pixi's dynamic-uniform and worker-loading defaults incompatible with the strict CSP. The renderer now uses Pixi's static uniform implementation and main-thread asset decoding. CSP remains without `unsafe-eval`, and workers remain disabled.

## Motion and visual inspection

`node scripts/desktop-rig-preview.mjs` renders the actual Pixi rig across idle, walking, pickup, climbing, sleep, stretch, fall, sitting, yawn, and click poses, plus five body colors. The contact sheet was inspected. Hanging foot attachment and outward arm stretch were corrected. Eyes, smile, plush texture, proportions, and cream headphones remain the same master assets. Runtime silhouette masks suppress disconnected atlas debris; source atlas and provenance remain in the repo.

`node --import tsx scripts/desktop-soak.mjs` completed **30 simulated minutes with 20 scripted windows**, at 60 presentation samples/second. It includes moving/removed windows and a permission-loss interval. The run stayed finite and continuous; maximum root displacement was 9.97 logical pixels in a frame. It generated 3,298 interactions, with at most three policy voices and bounded dedupe history. A separate ten-minute single-window test exercises successful climbing, hanging, pull-up, and subsequent walking. This is virtual-time simulation evidence, not a native 30-minute desktop soak.

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

A live resource probe runs the packaged application with 20 actual fixture windows present and sound muted. The first active run ended after 35.6 seconds when the Playwright target closed; it is not evidence of a completed long soak. A diagnostic rerun and final review are in progress. Resource figures and the final outcome will be updated before handoff. No universal CPU/memory or end-to-end frame-delivery guarantee is claimed.

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
