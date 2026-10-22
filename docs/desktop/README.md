# My Own Dots on the desktop

My Own Dots is a macOS Electron workspace with a plush desktop companion. The main window contains Chats, specialist Dots, Spaces and their page editor, activity, memory, connections and settings. The navigation rail selects an area, the context sidebar selects its content, and the optional context pane shows details without leaving the current work. Quick navigation searches Dots, Spaces, conversation titles and application sections. Pages are browsed and searched inside each Space.

| Shortcut | Action                              |
| -------- | ----------------------------------- |
| **⌘K**   | Quick navigation                    |
| **⌘N**   | New chat                            |
| **⌘,**   | Workspace settings                  |
| **⌘⇧B**  | Toggle sidebar                      |
| **⌘Q**   | Quit and stop the app-owned backend |

Closing the main window hides it and preserves ongoing work. Click the Dock icon, choose **File → Open Workspace**, or use **Open Workspace** in the menu-bar icon to return. Launching again reuses the existing app. Quit closes the app and stops only the backend it started; PostgreSQL volumes remain intact and externally managed services keep running.

On launch, Dot floats above a glowing platform while the app reads your workspace, checks local services and starts its backend. One small status line follows actual startup events beneath Dot, with a thin progress animation. The app opens your workspace immediately when ready. Longer waits reveal retry and workspace selection controls. Click Dot for a greeting. The screen follows system light/dark appearance and reduced-motion preferences, and pauses animation when hidden. **Workspace Setup…** opens the same design with configuration controls expanded.

## Run or install

Source builds require Node 24+, Xcode command-line tools and `npm ci`. For subscription chat, install Docker with Compose, Python/uv and your chosen AI CLI, and sign in to that CLI. From the checkout:

```sh
npm run setup:local
npm run setup:llm
npm run llm:check
npm run desktop:dev
```

The app can start configured local PostgreSQL through Docker Compose when needed; Docker must already be installed and available. `npm run conversations:up` is also available for an explicit database start. Subscription inference runs on the host through the app-owned Integrator dependency. Python environments, authenticated CLI profiles, Docker, database data and optional voice models are not bundled into the app.

To build a reviewable application:

```sh
npm run desktop:package
open "release/My Own Dots-darwin-arm64/My Own Dots.app"
```

The package targets the current Mac's architecture. On Apple Silicon it writes `release/My Own Dots-darwin-arm64/My Own Dots.app` and `release/My-Own-Dots-macOS-arm64.zip`. Copy the `.app` into Applications if desired. It includes Electron, the production Node backend and dependency closure, local Python source/support files, the Swift observer, artwork and effects. It launches without a source checkout. See [migration notes](electron-migration.md) for packaging boundaries and [verification](verification.md) for measured evidence.

## Workspace ownership and existing data

A packaged app creates its default workspace under `~/Library/Application Support/My Own Dots Desktop/workspace`. Source launches initially use the checkout recorded by the development build. A selected folder persists across launches. **My Own Dots → Workspace Setup…** opens the in-app setup and recovery controls; choose your existing original project folder there to reuse its `.env`, SQLite database and PostgreSQL configuration in place. Existing owner identities and credentials must stay stable. No automatic export, copy or new database replaces that workspace. Keep backups of both SQLite and PostgreSQL.

The app starts a bundled API-only backend on the configured loopback host/port. Its interface is bundled at `dots://workspace`, including compact chat; `GET /` on the production backend returns 404. No browser page or separately launched source server is needed. The authenticated identity endpoint prevents an occupied port from being mistaken for the selected workspace, and the database runtime lease prevents a second backend from opening the same SQLite store. Recovery offers retry and workspace setup inside the app.

Command Center can still manage a Dots backend. When taking over an older original service on port 4310, stop that service through Command Center first: older services lack the new identity endpoint and automatic ownership detection will refuse to attach. Do not launch two owners for the same database. For an explicit externally managed attachment, launch with `DOTS_WORKSPACE_URL=http://127.0.0.1:4310` and select the matching workspace `.env`/owner token. Only loopback HTTP addresses are accepted. Explicit attachment supports the older API, and Quit leaves that service running. New workspace configurations use unique Compose project names; existing legacy `.env` files keep the `my-own-dots-local` project fallback and its data volume.

For controlled source launches, `DOTS_WORKSPACE_DIR` chooses the workspace folder and `DOTS_DESKTOP_USER_DATA` isolates preferences/window state. Launcher overrides take precedence over folder selection, so update the launcher to change them. Existing companion preferences remain in `~/Library/Application Support/My Own Dots Desktop`; moving to the full workspace preserves them.

`npm run dev` remains the Vite development harness at `http://127.0.0.1:5173`. `npm run build && npm start` runs the headless API; it does not serve the production workspace UI.

## Workspace backup and recovery

In the desktop workspace, open **Settings → Backup & restore**. The same controls are available in **Workspace Setup…** when the main workspace cannot open.

- **Backup:** choose a filename and location in the native save dialog, optionally enable **Protect with a password**, then select **Save backup**. No password is required by default. Dot reads the completed file back and checks its contents before reporting success. Finish active chat or voice work first.
- **Restore:** select a backup file. Dot asks for a password only when that file is encrypted. Select **Review backup**, check the summary, then **Restore**. Dot prepares a separate workspace beside the current one and opens it; the original stays in place. You do not need to choose another destination. Legacy PostgreSQL backups still require an available PostgreSQL server with permission to create a database. Previews expire after 15 minutes; **Cancel** discards unused preparations after ownership checks.

A backup without a password can be read by anyone with access to the file. If you enable protection, keep the password independently: Dot cannot recover an encrypted backup without it. Both choices work for manual backups without OS secure credential storage. Existing encrypted backups remain supported. Choose a new filename for each backup; existing files are never overwritten. Store a copy on another drive for protection against disk failure.

**Advanced options** holds the workspace location, move controls and optional daily backups. For automatic backups, first save an encrypted backup with **Remember password for automatic backups** selected, choose an automatic backup folder, then enable daily backups. This requires OS secure credential storage. Dot backs up changed data while open and idle, retaining seven daily and four weekly recovery points. Manually named backups are never pruned. Changing the automatic backup folder disables scheduling until you opt in again and leaves the old folder untouched.

Older workspaces also have a one-time **Upgrade storage** action in advanced options. Choose where to save the included backup and whether to protect it, then start the upgrade. Dot closes chat, verifies the backup, and prepares an upgraded workspace beside the current one. Review the result and select **Finish upgrade**. The original workspace and Docker data remain available. Once the SQLite workspace opens, this action disappears. An ordinary backup does not change the active storage engine. The fresh-install SQLite default remains gated on the pending chat and voice performance checks.

Backups cover core SQLite/PostgreSQL data, including conversations, memory history and suppression records, pages and voice transcripts. Computer files, browser profiles and provider/OS credentials are excluded. Restored schedules remain paused and external access requires new approval. Individual Dot transfer and remaining platform/release checks are still pending; see [verification and remaining release gates](storage-verification.md).

## Companion and compact chat

The companion walks, rests, stretches, sleeps, jumps, looks around, waves, grooms, adjusts its headphones and responds to clicks, petting or pinching pickup. With Accessibility enabled, it uses exposed window tops and sides, climbs, hangs and falls when a supporting window moves. Its color changes without replacing its character or animation.

Click Dot to open **Chat · Talk · Hide** clouds. Escape or clicking outside dismisses them, and arrow keys navigate the choices. **Chat** opens a compact focusable conversation window using the same bundled workspace and backend: Dots, AI configuration, history, stop controls and approval cards are shared. The workspace button hands the selected Dot and conversation to the main window. Closing compact chat preserves its conversation; reopening reuses it. The avatar reflects this Dot's saved appearance. **Talk** starts a local call after the speech setup checks. **Hide** hides the companion and compact chat; **Show Dot** restores it from the menu bar. Hiding the companion leaves the main workspace available.

Main and compact renderers are sandboxed and use narrow native bridges for workspace navigation, voice and explicit folder selection. Provider credentials, process launching and owner-token transport stay in the host/backend. Workspace settings and Customize Companion remain separate controls.

See [local voice calls](local-voice-calls.md) for setup and testing. Local Whisper, Silero and Kokoro wrap the existing chat agent, preserving approval cards and conversation history. Ordinary inference remains buffered; the opt-in persistent-provider voice path can deliver validated response text incrementally. The [file-audio prototype report](local-voice-prototype.md) records earlier offline checks.

The per-Dot **Basic / Medium / High** selector is available in Dot settings and chat before setup. Basic accepts voice and replies in text without speech generation; Medium preserves current speech output and is the legacy default. Basic reveals chat when invoked by companion Talk or the shortcut. High uses local LFM audio plus a local router, with governed subscription tasks in linked conversations. It requires Apple Silicon macOS, the separate pinned native runtime and SQLite storage; missing setup produces an explicit reason. See the [implementation handover](voice-quality-handover.md) and [native evaluation status](native-voice-evaluation.md).

Chat's **Voice & personality** controls select from 28 installed English voices and Natural, Cheerful, Calm, or Serious personalities. **Preview** uses a fixed local phrase; **Save** applies the choice to that Dot. A Dot can also [request local folder access](folder-access.md): the owner reviews the folder and read or editing access, and approves before file tools can use it. **Folder access** lists grants and supports revocation.

By default packaging uses a **local ad-hoc signature**. For a stable identity across rebuilds, explicitly select an installed code-signing identity:

```sh
DOTS_CODESIGN_IDENTITY='your installed signing identity or fingerprint' npm run desktop:package
```

The observer and nested app components are signed inside out, then verified. Certificate mode rejects hash-pinned designated requirements. A failed requested identity stops packaging; it never silently falls back to ad-hoc. No certificate details are included in the build report. Set `DOTS_DESKTOP_RELEASE_DIR` to a separate output folder when packaging while an earlier build is running; never overwrite a running `.app`. Packaging does not upload or notarize the app, and these artifacts are not a public Gatekeeper-approved distribution. The build targets macOS 14+, but only the architecture and OS recorded in [verification.md](verification.md) have been exercised; Intel and other macOS versions are not advertised as verified.

## Interaction and preferences

- Press **Command + Shift + Space** to start talking without opening a window or taking focus from your current app. Press it again to end, including while connecting. Dot holds its position, cups a hand toward its headphones while listening, looks upward while thinking, and moves its mouth and arms while speaking. The menu-bar icon also reports the current phase and provides **End talk**. Calls use the desktop Dot and its conversation, with the same local voice setup as Talk.
- In **Customize Dot → Windowless talk**, click the shortcut button and press a combination with Command, Control or Option. Escape cancels recording. **Use ⌘ ⇧ Space** restores the default; **Disable** removes the global shortcut. Changes persist across launches. A conflicting shortcut leaves your previous selection intact. Recording temporarily releases the shortcut so it can be captured without starting a call.
- Windowless calls keep the chat renderer hidden. Folder requests open an approval panel beside Dot; the named folder is preselected when found, with **Choose folder** as a fallback. Approve or decline there. Closing the panel keeps the request pending, and **Review folder requests** in the menu bar reopens it. Open **Chat** for captions, microphone/speaker controls, page approvals, or connection approvals. Setup failures appear in the menu bar and a desktop notification. Hiding Dot, locking/sleeping, navigation, renderer failure, or connection loss ends the call; it never restarts automatically.
- Click the body for an acknowledgment and the floating menu. Roaming pauses while the menu is open. Move at least four logical pixels while pressing to pick it up; releasing a drag does not open the menu.
- Pickup gathers the actual grabbed fur point using the ordinary pointer, with no drawn hand. Dot keeps a wide-eyed, round-mouth expression while held. The body stretches slightly, limbs dangle, and movement gives it bounded sway. Release lets the current motion flow into falling and landing.
- Move the pointer nearby to draw Dot’s gaze. Gently rub back and forth over its body without pressing to pet it: happy eyes, blush, and three staggered heart bubbles appear above its upper-right. A stationary hover or one pass does not trigger petting.
- Sitting lowers the rump onto the supporting surface with visible forward paws. Sleep uses the same seated posture with closed eyelids. Short curious gestures alternate with travel and rest; window-ledged peeks happen only near a supported window edge.
- The transparent area around Dot passes clicks to the application underneath. The ambient panel does not take keyboard focus.
- Use the menu-bar icon for **Customize Dot**, color presets, volume, mute, pause, reduced motion, hide/show, recovery, tracking status, and Quit. The color picker, master volume, and separate **Walking, Interactions, Climbing, Falls & landings, Rest & idle** levels save automatically. Choose a category in the dropdown, then adjust its slider; its level multiplies the master volume. Zero silences that category without stealing another sound’s voice slot.
- Hiding folds Dot into a small circle at its body center that pops away; showing pops a circle in at the same center and unfolds it into Dot. A subtle droplet sound follows master and Interactions volume. Quick toggles reverse smoothly, and reduced motion uses a short fade.
- A second launch reuses the existing companion. The app respects macOS reduced motion and can also suppress automatic roaming through its own controls.

Companion preferences are separate from workspace data, in `~/Library/Application Support/My Own Dots Desktop/preferences.json`. They include color, sound, motion, the talk shortcut, and a display-relative placement. Native window IDs, active grips, and call intent are never persisted.

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
npm run desktop:smoke
# Or test an already packaged executable:
npm run desktop:smoke -- "release/My Own Dots-darwin-arm64/My Own Dots.app/Contents/MacOS/My Own Dots"
```

`desktop:smoke` launches the real app twice from a disposable directory with isolated workspace and userData, muted effects, blank provider keys and a free loopback port. It checks authenticated backend identity and API, rejected unauthenticated access, API-only root 404, a Space saved in SQLite across restart, and orderly process/port/lease cleanup. It needs no Docker initialization and makes no AI or microphone requests. Measurements and limits go to `artifacts/desktop/process-smoke.json`. This is process/API acceptance; native navigation, pixels, compact handoff and real chat/voice require separate native interaction checks.

`desktop:runtime:smoke` checks the bundled backend under Electron's Node runtime without launching the native app. `desktop:preview` remains a historical visual generator for the companion contact sheet; it is not full-workspace acceptance. The old `desktop-chat-smoke.mjs`, `desktop-windowless-smoke.mjs`, `desktop-live-soak.mjs` and `desktop-visibility-smoke.mjs` harnesses now fail immediately with a retirement message. Their original companion-only assumptions are unsupported after this migration; their source and earlier evidence remain for reference.

See [verification.md](verification.md) for fresh measured checks, historical records, and outstanding native/OS acceptance. Windows/Linux adapters and public notarization remain future work. Owner feedback about earlier voice reliability is historical evidence; migration acceptance does not include fresh microphone, speaker, echo or latency measurements.

### Per-Dot customization and desktop selection

In **Dot settings → General**, **Customize…** opens that Dot's appearance and behavior controls. Create a new Dot before customizing it. Colors, accessories, sound levels, mute, roaming, and reduced motion save independently in the workspace database. Existing Dots retain the previously shared customization on first launch after upgrading; new Dots start with the default appearance and behavior.

**Use on desktop** replaces the saved desktop selection. Exactly one Dot is selected, marked **On desktop**. Selecting a different conversation or creating a Dot does not change it. The desktop companion's Chat and Talk use the selected Dot. End a desktop call before switching.

The menu-bar **Customize Dot**, color, sound, and movement controls affect the desktop Dot. The editor names the Dot being changed, and editing another Dot leaves the desktop companion alone. The Talk shortcut remains an app-wide preference. Customization and the desktop selection travel with workspace backups; the shortcut and desktop position remain machine preferences.
