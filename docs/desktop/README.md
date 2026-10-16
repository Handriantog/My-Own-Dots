# My Own Dots on the desktop

The macOS companion gives one plush Dot a local desktop playground. It walks, rests, stretches, sleeps, jumps, and responds to a click or pinching pickup. With Accessibility enabled, it can use exposed application-window tops and sides, climb, hang, pull itself up, and fall when a supporting window moves or disappears. Its body color changes without replacing its character or animation.

The operational controls live in the menu-bar Dot icon. Chat, voice, research, and agent tasks remain future companion integrations; this app does not load the existing web workspace or connect to its backend.

## Run or install

From a source checkout with Node 24+, Xcode command-line tools, and dependencies installed:

```sh
npm run desktop:dev
```

For a self-contained application:

```sh
npm run desktop:package
open "release/My Own Dots-darwin-arm64/My Own Dots.app"
```

The package command builds the current Mac's architecture. On Apple Silicon it produces `release/My Own Dots-darwin-arm64/My Own Dots.app` and `release/My-Own-Dots-macOS-arm64.zip`. The application includes Electron, the Swift observer, artwork, and all 69 sounds. Copy the `.app` into Applications if desired; its runtime does not require Node, Python, Docker, the source checkout, internet access, or a running web server.

This is a **local ad-hoc signed build**, without Developer ID signing or notarization. It is not a public Gatekeeper-approved distribution. Public release signing needs the owner's Apple release identity. The build targets macOS 14+, but only the architecture and OS recorded in [verification.md](verification.md) have been exercised; Intel and other macOS versions are not advertised as verified.

## Interaction and preferences

- Click the body for a small acknowledgment. Move at least four logical pixels while pressing to pick it up.
- A drawn thumb-and-finger pinch gathers the actual grabbed fur point. The body stretches slightly, limbs dangle, and movement gives it bounded sway. Release lets the current motion flow into falling and landing.
- The transparent area around Dot passes clicks to the application underneath. The ambient panel does not take keyboard focus.
- Use the menu-bar icon for **Appearance & sound**, color presets, volume, mute, pause, reduced motion, hide/show, recovery, tracking status, and Quit. The custom color picker and volume slider save automatically.
- A second launch reuses the existing companion. The app respects macOS reduced motion and can also suppress automatic roaming through its own controls.

Preferences are separate from web-workspace data, in `~/Library/Application Support/My Own Dots Desktop/preferences.json`. They include color, sound, motion, and a display-relative placement. Native window IDs and active grips are never persisted.

## Window play and privacy

The menu reports **Floor-only** when Accessibility is unavailable or native tracking has failed. Floor roaming, dragging, color, and sound remain usable. Choose **Enable window play in System Settings…**, grant this application Accessibility, then choose **Retry window tracking**. The helper checks permission periodically and refreshes geometry when it changes. A rebuilt development app may need renewed macOS authorization because its ad-hoc identity changed.

The helper reads public window rectangles, ordering, display information, and Accessibility window-change notifications. It does not read window titles, text, screenshots, or document contents. It never moves or operates another application's windows. There are no microphone or screen-capture streams.

Window tops are approximate one-way platforms. Only exposed edges with room for Dot are eligible. A fullscreen window flush with the screen ceiling has no usable top perch. The display's usable bottom is the floor; individual Dock icons and Dock magnification are not colliders. Ordinary application windows and fullscreen Spaces are the intended stacking scope; lock/login and protected system surfaces remain controlled by macOS.

Automatic exploration stays on the current monitor. Dragging can transfer Dot to another monitor. If a display disappears, the app hides the old presentation and introduces Dot on a remaining display. Helper failures fall back to the floor with bounded retries and a manual retry control.

## Sounds and artwork

The existing 23 sound families each have three original variants. The runtime predecodes the local pack, deduplicates events, honors cooldowns, limits the audible mix to four voices, and cancels falling sounds on pickup or landing. Default effects volume is 40%. The owner has deferred refinement of rough effects; these sounds remain provisional.

The character uses a shared layered plush atlas and a small mesh/limb rig, with a separate original hand cursor. See [asset notes](asset-notes.md) for source provenance and color protection. Very dark body choices retain a minimum material brightness so fur detail remains visible.

## Development checks

```sh
npm test -- tests/desktop
npm run desktop:build
npm run desktop:preview
npm run desktop:smoke
```

`desktop:preview` writes an action/color contact sheet under `artifacts/desktop/`. `desktop:smoke` launches the standalone development bundle from outside its checkout, checks the renderer sandbox and overlay configuration, and writes a screenshot/report. A packaged executable path can be passed to `scripts/desktop-smoke.mjs` to test the installed layout. These checks supplement the actual desktop interaction matrix in [verification.md](verification.md).

The existing `dev`, `build`, `start`, and web/server test commands retain their original roles. Windows and Linux adapters, app signing/notarization, assistant integration, and sound refinement are future work.
