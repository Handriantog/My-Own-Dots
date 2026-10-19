# My Own Dots desktop migration

The owner wants to retire the browser workspace and make My Own Dots a complete Electron application with its own backend. Command Center may also start it. The owner explicitly authorized autonomous design and implementation while asleep; review gates are waived for this session. Preserve existing data, inference integrations, approvals, and the roaming companion.

## Product direction

Use Slack's navigation rail and contextual sidebar, Discord's clear conversation identity and nearby call controls, and Teams' connection between conversations and working documents. Keep Dots' own restrained blue identity and plush character. Avoid copying brand palettes or unrelated social/team features.

Reference research:
- https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences — navigation bar, grouped sidebar, adjustable width.
- https://discord.com/blog/how-to-navigate-discord-using-only-your-keyboard — distinct navigation regions, keyboard access, visible focus.
- https://support.microsoft.com/en-us/teams/teams-channels/explore-the-new-chat-and-channels-experience-in-microsoft-teams — organized chats/channels and focused navigation.

The main window has an integrated draggable title bar with native traffic lights, a quick switcher, an app rail, a contextual sidebar, a content area, and an optional computer/results pane. The rail contains Chats, Spaces, Activity, Memory, and Settings. Chats lists Dots and conversation history. Spaces lists the existing spaces/page trees. Activity preserves scheduled tasks and run details. Memory preserves existing review/edit/forget/learning controls. Settings groups application and Dot controls without removing capabilities. Use dense, readable controls, subtle borders, system/light/dark themes, blue selection, and bounded panels filling the window. Remove template branding and browser-specific navigation.

Keyboard shortcuts: Command/Ctrl+K opens quick navigation across Dots, Spaces and app sections; Command/Ctrl+N starts a chat; Command/Ctrl+, opens settings. Escape closes transient surfaces. Main window geometry and navigation persist where safe. Unsaved-page guards still apply. At compact widths, collapse auxiliary panels before primary content.

## Desktop ownership and launch

Electron owns a normal Dock/task-switcher main window, application menu, companion overlay, compact chat and windowless voice. Normal launch opens the workspace and companion. Dock activation/second instance restores the main window. Closing the main window hides it while the companion remains; Quit explicitly shuts down owned backend processes. Companion Chat stays compact and can open its selected conversation in the workspace. Internal page links stay inside the app; external HTTP(S) links open in the system browser.

The frontend is bundled with Electron and loaded from a privileged application protocol. Production backend serves APIs and health only, not the former browser SPA. A same-origin protocol proxy sends /api requests to the local backend, including streaming bodies and abort signals, without exposing filesystem/process powers to renderers. Restrict destinations to validated loopback addresses; external navigation never receives privileged bridges or backend credentials. Context isolation, sandboxing and nodeIntegration:false remain mandatory.

The application bundles the compiled backend and its production dependencies. It launches that backend with Electron's bundled Node runtime. AI CLIs, Python speech setup, Docker and optional computer services remain integrations; do not bundle credentials, databases, downloaded models or developer virtual environments. Existing inference logic remains in myown-llm-integrator.

Backend startup belongs to a dedicated host module. It loads configuration from a workspace folder, places new installations under Application Support, and supports an explicit DOTS_WORKSPACE_DIR override for existing .env/data. Development defaults to the source workspace. Respect absolute and relative database paths without moving/deleting existing data. Supply safe local defaults for new installs, with actionable service/setup failures. Start configured local PostgreSQL using the bundled compose file when possible; never reset volumes. If the configured backend is already running and positively identified as this workspace, attach without creating a second runner; explicit DOTS_WORKSPACE_URL may attach to a local Dots service. Never kill an externally owned service. If an occupied address cannot be identified safely, report the conflict and offer retry/configuration rather than starting another runner on the same database.

Startup/recovery appears inside the app with progress, retry, configuration and useful errors. It must not leave a blank window or require a browser. Backend shutdown waits for graceful termination and only escalates against the child it owns. Port conflicts, malformed configuration, early exits and missing optional dependencies must be bounded and understandable. No secret values in logs or errors.

## Feature preservation

Keep streamed chat, durable history, stopping runs, all tool approval cards, local calls, windowless talk, folder approval/revocation, voice/personality selection, Dot CRUD/permissions/Space access, page editor/autosave/revisions, scheduling/task actions, memory and learning, MCP/Composio/Slack settings, computer controls and results. Do not replace real views with decorative placeholder screens. Share feature components between main and compact chat, but distinguish the two surfaces explicitly.

## Verification and delivery

Use behavioral tests for backend ownership/lifecycle, protocol trust and streaming, native window navigation, quick navigation and unsaved-state handling. Run existing regression suite, typecheck, lint, formatting, app/backend builds and packaged launch smoke. Inspect actual Electron windows in light/dark and compact layouts where tooling permits. Use disposable data and fixture AI for automated execution; do not send real messages or capture microphone audio for verification. Record unverified external-provider/OS behavior honestly. Deliver source branch, runnable app artifact, screenshots when possible, launch instructions and remaining decisions. Do not publish or merge without an explicit instruction.
