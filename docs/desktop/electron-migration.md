# Electron workspace migration notes

The full workspace now ships in My Own Dots alongside the existing desktop companion. This source change is on `feat/electron-workspace` for review; delivery does not merge or publish it. Current measured checks and acceptance limits are recorded in [verification.md](verification.md).

## What changed

The native app owns a main workspace window, compact companion chat, menu commands, recovery/setup controls and a bundled API backend. Main and compact surfaces load the same renderer at `dots://workspace`, with relative API requests transported to the selected loopback backend by the native host. Production HTTP serves APIs only: the root returns 404. Vite remains a developer harness.

The workspace uses a navigation rail, a searchable context sidebar, recent conversation history and an optional detail pane. Quick navigation reaches Dots, Spaces, pages and application destinations; native menu commands expose the same navigation actions. Closing the main window hides it, and Quit shuts down the owned backend. Explicitly attached services are not stopped.

Existing Dots, Spaces, pages, curated memory, approvals, settings and schedules remain in the selected SQLite store. Local conversation history remains in its configured PostgreSQL database. Selecting an original project folder reuses its `.env` and resolved data paths without copying them. The existing `My Own Dots Desktop` userData directory retains companion preferences; fresh packaged workspaces live beneath its `workspace` directory. Existing legacy Compose projects retain their data volume; new configurations receive unique project names.

## Runtime and external setup

The app bundles Electron, compiled production backend modules, the production npm dependency closure including Integrator and its Python source, voice support source/manifests, Compose support, native observer and renderer assets. Developer checkouts, `.env`, private credentials, `.venv` directories, live databases and model caches are excluded. The staged production dependency closure currently contains 450 packages and is roughly 470 MB; this is staging evidence, not the final app/archive size. Final artifact measurements belong in the verification record.

Subscription inference still requires a supported AI CLI authenticated on this Mac and a Python environment prepared with uv. Docker/PostgreSQL are local prerequisites for the default conversation backend. Optional speech requires its separately installed Python runtime/models and explicit setup. Credentials and model downloads are not shipped. A clean package can open recovery/setup before those integrations are ready; a process smoke with intentionally blank keys does not establish real chat readiness.

Command Center remains an optional external launcher. This migration changes Dots ownership when launched directly; it does not modify the sibling Command Center implementation. See [workspace setup](README.md#workspace-ownership-and-existing-data) before taking over a previously running service. Public Developer ID signing, notarization and Intel/native OS acceptance are separate release gates.

## Design references and attribution

The information architecture adapts familiar desktop interaction ideas: separate navigation and content, conversation grouping, contextual detail, and keyboard navigation. Reference reading included [Slack sidebar preferences](https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences), [Discord keyboard navigation](https://discord.com/blog/how-to-navigate-discord-using-only-your-keyboard), and [Teams chat and channels](https://support.microsoft.com/en-us/teams/teams-channels/explore-the-new-chat-and-channels-experience-in-microsoft-teams). Dots adapts these concepts to its own Chats, Dots, Spaces and local ownership; it does not claim feature parity. No reference product screenshots, logos or other assets were copied.

The upstream OpenDots MIT attribution and dependency notices remain. Integrator is an app-owned dependency and retains its AGPL-3.0-only license; see the root [license notes](../../README.md#license).
