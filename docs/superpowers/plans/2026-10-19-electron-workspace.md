# Electron Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser workspace with a complete Electron application owning its backend and redesigned desktop interface.
**Architecture:** Bundle the existing React feature components and backend. Separate backend lifecycle, Electron window/protocol hosting and workspace shell. Preserve the companion's compact chat and voice lifecycle.
**Tech Stack:** Electron 44, Node 24+, TypeScript, React, Vite, Hono, PostgreSQL/SQLite, Vitest.
**Spec:** docs/superpowers/specs/2026-10-19-electron-workspace-design.md

## Global Constraints

- macOS remains the supported packaged platform; retain native companion behavior.
- No credentials, live data, virtual environments or downloaded models in release artifacts.
- Context isolation and sandboxing enabled; nodeIntegration:false for renderers.
- Preserve all existing features and application permission/approval boundaries.
- Source worktree: .worktrees/electron-workspace, branch feat/electron-workspace.
- User authorized autonomous implementation and deferred all questions until delivery.

## Review Focus

- Existing externally owned backend: attach only after identity validation; never stop it.
- Backend startup failure or port collision: bounded recovery UI; no duplicate database runner.
- Protocol requests: no traversal, arbitrary proxy host, credential leakage or lost SSE cancellation.
- Switching from dirty page or active call: preserve guard and call lifecycle.
- Packaged app outside checkout: use bundled runtime/assets and persistent configured data.

### Task 1: Owned backend runtime and packaging

**Files:** Create src/desktop/host/workspace-backend.ts and supporting runtime helpers as needed; modify src/server/index.ts, scripts/build-desktop.mjs, scripts/package-desktop.mjs and package scripts; add tests/desktop/workspace-backend.test.ts and behavioral packaging/startup tests.
**Interfaces:** Export WorkspaceBackend with constructor options { bundle:string, data:string, sourceRoot?:string }, start():Promise<{url:string; ownerToken?:string; owned:boolean}>, stop():Promise<void>. Optional status subscription/configuration helpers may be added and documented for Task 2. bundle is dist/desktop/app runtime root; data is Electron userData. Task 2 consumes start/stop and handles UI.

- [ ] Write failing behavioral tests for owned start/stop, attach behavior, conflicting ports, early child exit and configuration/data paths, using injected process/network boundaries where required.
- [ ] Run the tests and confirm missing behavior fails.
- [ ] Implement backend startup/configuration, identity, dependency setup/status and bounded shutdown. Make server API-only in packaged desktop mode; retain a deliberate dev harness if needed.
- [ ] Package compiled backend and production dependencies without secrets or host-specific venvs. Bundle compose/setup support; document integration prerequisites.
- [ ] Run focused tests and typecheck. Report exact host API and packaging layout, then commit only task files.

### Task 2: Main workspace window and bundled renderer transport

**Files:** src/desktop/main.ts; new src/desktop/host/workspace-window.ts, workspace-protocol.ts; preload/shared desktop bridge; src/desktop/host/chat-window.ts and companion bridges; desktop renderer recovery UI; vite configs/build integration; tests/desktop/workspace-window.test.ts and workspace-protocol.test.ts.
**Interfaces:** Consume Task 1 WorkspaceBackend. Expose window.dotWorkspace with a narrow typed bridge for openWorkspace({dotId?,threadId?,spaceId?,pageId?}), connection/retry/status and native preferences actions as required. Main renderer receives surface=workspace; compact receives surface=companion. Host owns protocol origin and backend credentials. Share a single backend across windows. Coordinate App props/URL navigation with Task 3 before changing contracts.

- [ ] Write failing tests for local-only proxying, traversal rejection, streaming/abort, native window reuse and internal handoff.
- [ ] Implement main window, menu/Dock activation and geometry persistence, startup/recovery, bundled protocol assets/API proxy and trusted preload bridges.
- [ ] Adapt compact chat to the bundled UI; retain voice/folder trust and hidden-call behavior. Workspace links must not launch browser UI.
- [ ] Run host regression tests, typecheck and desktop build; commit task files and document bridge contract.

### Task 3: Desktop workspace interface

**Files:** src/client/App.tsx, main.tsx, style.css and new desktop shell/navigation modules/styles; WorkspaceDialog.tsx and focused feature layout adjustments; tests for navigation/guards and desktop rendering.
**Interfaces:** App supports explicit surface='workspace'|'companion' (retain desktop compatibility only if existing tests require it). Consume dotWorkspace bridge. Keep existing Chat, Spaces, Memory, task and settings contracts. URL handoff is #/chat/{dotId}/{threadId?} and existing #/spaces/{spaceId}/pages/{pageId}.

- [ ] Add failing tests for quick navigation, persisted selection, dirty-page guards and workspace/companion surface differences where behavioral coverage is useful.
- [ ] Build desktop titlebar, functional rail/contextual sidebar, command switcher and shortcuts with complete feature access.
- [ ] Restyle content/empty states, chat header/composer, documents, settings and secondary panes into a coherent desktop UI; retain light/dark/system preference.
- [ ] Remove template/browser branding and browser-open actions. Verify companion and real feature views still function.
- [ ] Run focused UI tests, typecheck, lint and build; commit task files.

### Task 4: End-to-end validation and delivery

**Files:** desktop smoke scripts, README.md, docs/desktop/README.md, docs/desktop/verification.md and delivery notes.

- [ ] Run full test suite, typecheck, lint, formatting and production builds. Investigate failures before claiming success.
- [ ] Exercise packaged main/compact startup, navigation and data persistence using disposable workspace fixtures. Inspect the actual native UI, including dark/light and narrow sizes where tools permit.
- [ ] Obtain fresh whole-branch review, fix substantive issues and verify fixes.
- [ ] Package a reviewable app and record launch instructions, measured verification, assumptions and remaining external dependencies. Leave the branch for owner review; do not merge/publish.
