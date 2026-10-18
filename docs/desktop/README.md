# My Own Dots on the desktop

The macOS companion gives one plush Dot a local desktop playground. It walks, rests, stretches, sleeps, jumps, looks around, waves, grooms, adjusts its headphones, and responds to clicks, petting, or pinching pickup. With Accessibility enabled, it can use exposed application-window tops and sides, climb, hang, pull itself up, and fall when a supporting window moves or disappears. Its body color changes without replacing its character or animation.

Click Dot to open three compact cloud speech bubbles surrounding it: **Chat · Talk · Hide**. Each has its own icon, soft shadow, and gentle opening animation; reduced-motion settings suppress the animation. Each cloud is 112×58 logical pixels, with a tighter arc above its shoulders. Chat sits to the left, Talk above, and Hide to the right; the arc folds inward at screen edges. Dot stays fixed in place while the menu is open, including mid-fall or mid-climb. The transparent center lets you click or pick up Dot to dismiss the menu. Escape or clicking outside dismisses them, and arrow keys navigate the choices. **Chat** opens a compact, focusable conversation window using the existing local web workspace. Its Dots, AI configuration, persistent history, stop control, and tool approval cards are shared with the full workspace. The chat avatar uses the desktop plush and your chosen body color, and color changes refresh without discarding the conversation or draft. **Talk** opens and automatically connects a local English voice call using the selected conversation; no preliminary Chat visit or second start click is needed. The call shows setup failures without opening the microphone. **Hide** hides Dot and its chat window; use **Show Dot** in the menu-bar icon to bring the companion back. Operational controls remain in the menu-bar icon.

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

The package command builds the current Mac's architecture. On Apple Silicon it produces `release/My Own Dots-darwin-arm64/My Own Dots.app` and `release/My-Own-Dots-macOS-arm64.zip`. The application includes Electron, the Swift observer, artwork, the 69-clip effects pack, and a synthesized droplet pop. Copy the `.app` into Applications if desired. Roaming, appearance, and sound run independently; AI chat needs your local workspace and its configured inference services.

## Connect chat

Start your Dots workspace in Command Center, or run `npm run build` followed by `npm start` from this checkout. The companion defaults to `http://127.0.0.1:4310`. For the web development server (`npm run dev`), use `http://127.0.0.1:5173`. The server and frontend must include this version's compact chat view.

When the workspace is offline, the chat box shows a connection screen with an editable address and retry button. **Chat connection…** in the menu bar reopens those controls at any time. Only loopback workspace addresses are accepted; a different local port is supported. The choice saves in `chat-connection.json` beside companion preferences. `DOTS_WORKSPACE_URL` can override the saved address at launch.

Choose a Dot in the chat header, type a message, and press Enter or Send. Shift+Enter inserts a newline. The history dropdown reopens saved conversations; the plus button starts a fresh one. Closing the window preserves the current conversation and any running response. Reopening reuses the same window, and the selection survives a restart. Owner-token authentication is handled by the existing workspace screen. The external-link button opens the full workspace in your browser.

The chat renderer is sandboxed. Only the configured local workspace main frame receives a narrow voice lifecycle bridge for readiness, call start/end, Talk intent, and forced stop; it has no file, process, or provider-credential access. The local connection screen exposes only validated connection controls. Provider credentials and inference stay in the workspace server; no separate AI client is bundled into the companion.

Loading and connection screens use a neutral speech symbol. Once connected, desktop chat shows the current plush and the body color selected in Customize Dot. Ordinary web chat retains its specialist avatars. The old fixed blue placeholder no longer flashes before the desktop appearance loads.

See [local voice calls](local-voice-calls.md) for setup and testing. Local Whisper, Silero and Kokoro wrap the existing chat agent, preserving approval cards and conversation history. Ordinary inference remains buffered; the opt-in persistent-provider voice path can deliver validated response text incrementally. The [file-audio prototype report](local-voice-prototype.md) records earlier offline checks.

Chat's **Voice & personality** controls select from 28 installed English voices and Natural, Cheerful, Calm, or Serious personalities. **Preview** uses a fixed local phrase; **Save** applies the choice to that Dot. A Dot can also [request local folder access](folder-access.md): the owner chooses a folder, reviews read or editing access, and approves before file tools can use it. **Folder access** lists grants and supports revocation.

By default packaging uses a **local ad-hoc signature**. For a stable identity across rebuilds, explicitly select an installed code-signing identity:

```sh
DOTS_CODESIGN_IDENTITY='your installed signing identity or fingerprint' npm run desktop:package
```

The observer and nested app components are signed inside out, then verified. Certificate mode rejects hash-pinned designated requirements. A failed requested identity stops packaging; it never silently falls back to ad-hoc. No certificate details are included in the build report. Set `DOTS_DESKTOP_RELEASE_DIR` to a separate output folder when packaging while an earlier build is running; never overwrite a running `.app`. Packaging does not upload or notarize the app, and these artifacts are not a public Gatekeeper-approved distribution. The build targets macOS 14+, but only the architecture and OS recorded in [verification.md](verification.md) have been exercised; Intel and other macOS versions are not advertised as verified.

## Interaction and preferences

- Press **Command + Shift + Space** to start talking without opening a window or taking focus from your current app. Press it again to end, including while connecting. Dot holds its position, cups a hand toward its headphones while listening, looks upward while thinking, and moves its mouth and arms while speaking. The menu-bar icon also reports the current phase and provides **End talk**. Calls use the selected Dot and conversation, with the same local voice setup as Talk.
- In **Customize Dot → Windowless talk**, click the shortcut button and press a combination with Command, Control or Option. Escape cancels recording. **Use ⌘ ⇧ Space** restores the default; **Disable** removes the global shortcut. Changes persist across launches. A conflicting shortcut leaves your previous selection intact. Recording temporarily releases the shortcut so it can be captured without starting a call.
- Windowless calls keep the chat renderer hidden. Open **Chat** yourself for captions, microphone/speaker controls, or approval cards; an approval shows an attention gesture and a menu-bar reminder. Setup failures appear in the menu bar and a desktop notification. Hiding Dot, locking/sleeping, navigation, renderer failure, or connection loss ends the call; it never restarts automatically.
- Click the body for an acknowledgment and the floating menu. Roaming pauses while the menu is open. Move at least four logical pixels while pressing to pick it up; releasing a drag does not open the menu.
- Pickup gathers the actual grabbed fur point using the ordinary pointer, with no drawn hand. Dot keeps a wide-eyed, round-mouth expression while held. The body stretches slightly, limbs dangle, and movement gives it bounded sway. Release lets the current motion flow into falling and landing.
- Move the pointer nearby to draw Dot’s gaze. Gently rub back and forth over its body without pressing to pet it: happy eyes, blush, and three staggered heart bubbles appear above its upper-right. A stationary hover or one pass does not trigger petting.
- Sitting lowers the rump onto the supporting surface with visible forward paws. Sleep uses the same seated posture with closed eyelids. Short curious gestures alternate with travel and rest; window-ledged peeks happen only near a supported window edge.
- The transparent area around Dot passes clicks to the application underneath. The ambient panel does not take keyboard focus.
- Use the menu-bar icon for **Customize Dot**, color presets, volume, mute, pause, reduced motion, hide/show, recovery, tracking status, and Quit. The color picker, master volume, and separate **Walking, Interactions, Climbing, Falls & landings, Rest & idle** levels save automatically. Choose a category in the dropdown, then adjust its slider; its level multiplies the master volume. Zero silences that category without stealing another sound’s voice slot.
- Hiding folds Dot into a small circle at its body center that pops away; showing pops a circle in at the same center and unfolds it into Dot. A subtle droplet sound follows master and Interactions volume. Quick toggles reverse smoothly, and reduced motion uses a short fade.
- A second launch reuses the existing companion. The app respects macOS reduced motion and can also suppress automatic roaming through its own controls.

Preferences are separate from web-workspace data, in `~/Library/Application Support/My Own Dots Desktop/preferences.json`. They include color, sound, motion, the talk shortcut, and a display-relative placement. Native window IDs, active grips, and call intent are never persisted.

If Dot disappears while its menu-bar icon remains, check the status line before choosing **Recover companion**. **Open diagnostic logs…** opens the local `diagnostics` folder beside preferences. It records Dot's visibility, permission/tracking status, position, renderer recovery reason, and startup failures. Event history rotates at 256 KiB with one previous file; a separate small file preserves the last uncaught host exception. Logs stay on this Mac and contain no other application's window titles, contents, or screenshots. They help distinguish a renderer failure, a hidden/suspended companion, and a native window placement problem.

## Window play and privacy

The menu reports **Floor-only** when Accessibility is unavailable or native tracking has failed. Floor roaming, dragging, color, and sound remain usable. Choose **Enable window play in System Settings…**, grant this application Accessibility, then choose **Retry window tracking**. The helper checks permission periodically and refreshes geometry when it changes. If Accessibility is already enabled but a rebuilt app stays Floor-only, remove its old entry from Accessibility, use the plus button to add the current `.app`, and enable it again. Then choose **Retry window tracking**. An old row can retain a grant for the previous ad-hoc build even when its toggle appears enabled; retrying the helper cannot renew that app identity. Do this once when moving from ad-hoc signing to a stable certificate identity, too. Keep using the same signing identity for later builds. No privacy database reset is needed. Apple's [code identity guidance](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) explains why ad-hoc signing ties authorization to one version of the code.

The helper reads public window rectangles, ordering, display information, and Accessibility window-change notifications. It does not read window titles, text, screenshots, or document contents. It never moves or operates another application's windows. The window helper opens no microphone or screen-capture streams. The separate chat call captures microphone audio only after an explicit Talk action, talk shortcut, or the chat call button. Hidden capture requires a fresh native windowless request; ordinary background pages cannot start calls.

Window tops are approximate one-way platforms. Only exposed edges with room for Dot are eligible. A fullscreen window flush with the screen ceiling has no usable top perch. The actual screen bottom is the floor. When public Accessibility geometry identifies an exposed Dock list, its limited rectangular footprint supplies a separate perch; beyond either end, Dot falls to the screen floor. Hidden or unavailable Dock geometry supplies no floating platform. Individual icons and magnified contours are not modeled. Ordinary application windows and fullscreen Spaces are the intended stacking scope; lock/login and protected system surfaces remain controlled by macOS.

Automatic exploration stays on the current monitor. Dragging can transfer Dot to another monitor. If a display disappears, the app hides the old presentation and introduces Dot on a remaining display. Helper failures fall back to the floor with bounded retries and a manual retry control.

## Sounds and artwork

The existing 23 sound families each have three original variants. The runtime predecodes the local pack, deduplicates events, honors cooldowns, limits the audible mix to four voices, and cancels falling sounds on pickup or landing. Default effects volume is 40%. The owner has deferred refinement of rough effects; these sounds remain provisional.

The character uses a shared layered plush atlas and a small mesh/limb rig. See [asset notes](asset-notes.md) for source provenance and color protection. Very dark body choices retain a minimum material brightness so fur detail remains visible.

## Development checks

```sh
npm test -- tests/desktop
npm run desktop:build
npm run desktop:preview
npm run desktop:smoke
node scripts/desktop-chat-smoke.mjs
node scripts/desktop-windowless-smoke.mjs
```

`desktop:preview` writes an action/color contact sheet under `artifacts/desktop/`. `desktop:smoke` launches the standalone development bundle from outside its checkout, checks the renderer sandbox and overlay configuration, and writes a screenshot/report. A packaged executable path can be passed to `scripts/desktop-smoke.mjs` to test the installed layout. These checks supplement the actual desktop interaction matrix in [verification.md](verification.md).

`desktop-windowless-smoke.mjs` uses a disposable workspace fixture and real Electron registration to check hidden startup, native user activation, stationary voice poses, toggle/end, shortcut recording/persistence/conflicts, disable/reset, and cleanup on lock or companion-renderer failure. It writes screenshots and a report under `artifacts/desktop/windowless/`. It invokes registered callbacks deterministically, without capturing microphone audio or requesting AI replies. Native shortcut delivery from other applications and live voice remain manual acceptance checks.

The chat smoke needs a running workspace. It checks the click menu, offline/API-only recovery, renderer isolation, compact layout, and close/reopen behavior. Add `--live` to send one tool-free connection-check prompt through the configured AI and verify its reply and history reload. This creates a real workspace conversation. Screenshots and reports go to `artifacts/desktop/`. Run `node scripts/desktop-menu-preview.mjs` to render the production clouds around the plush at their real sizes, including a screen-corner example.

The existing `dev`, `build`, `start`, and web/server test commands retain their original roles. Windows and Linux adapters, public notarization, and sound refinement are future work. The owner has tested local voice calls and confirmed improved reliability; controlled microphone, echo and speaker latency measurements remain separate checks. Possible later mouse gestures include a nose boop, double-click high-five, and opt-in cursor-follow play; these are proposals, not active shortcuts.
