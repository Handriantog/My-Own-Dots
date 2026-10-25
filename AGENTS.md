# My Own Dots development instructions

Follow the parent MyOwnStack instructions and read this repository's README before implementation.

## Worktree location

The owner requires all implementation work for this project to use worktrees inside the primary checkout's `.worktrees/` directory.

- Find the primary checkout with `git worktree list --porcelain`. Create or reuse `<primary-checkout>/.worktrees/<task-name>`.
- Reuse an appropriate existing worktree. Do not nest worktrees inside another linked worktree.
- Do not implement in the primary checkout or use `~/.codex/worktrees/` or another external worktree location unless the owner explicitly changes this preference.
- If a session starts in an externally created worktree, relocate it with `git worktree move` before implementation. Preserve its commits, staged changes, unstaged changes, untracked files, and ignored local setup files.
- Verify `.worktrees/` is ignored, inspect existing changes, and preserve unrelated work. After relocation, update generated absolute paths and verify the relevant build or launch setup.
- Use native worktree tools only when they honor this project-local location.

This preference applies to future implementation sessions for this repository. It concerns development checkouts; application workspace data follows the product's storage configuration.

## Agent reliability baseline

Read [the reliability requirements and development rules](docs/development/agent-reliability.md) before changing agent, voice, tool, permission or delivery behavior. Its next-agent handoff links the approved decisions and maps postmortem lessons to regression tests.

- High voice is a core product requirement. Text and voice must preserve the same task identity, relevant context, permissions, cancellation and truthful outcome reporting. Do not silently narrow voice to casual conversation.
- Speech recognition and speech generation must stay local. The companion must not require another subscription or separately billed inference/speech API beyond a supported AI subscription the user already has. Do not silently fall back to paid APIs when setup, connectivity or subscription allowance fails; report the limitation. Local speech does not imply offline task reasoning.
- The owner selected Codex first for the new execution layer. Other providers are deferred until they satisfy the same acceptance checks; this does not authorize removing existing provider paths or silently expanding Integrator's inference-only APIs.
- The baseline covers correct folder approval, dependable installed Abilities, and project debugging through inspection, edits and tests. Do not describe planned capability as implemented or tested.
- Before implementation, define observable success, important failure/recovery cases, and how to verify them. For cross-process changes, include at least one test through the actual affected boundary; mock-only results do not establish native or live-model behavior.
- An accepted request, completed tool call and verified user outcome are different states. Preserve uncertainty, check current state before replaying actions, and expose actionable prerequisite failures without leaking private content.
- Treat source folders, application data folders and build locations as different identities. Resolve the intended project from evidence; if ambiguous, clarify. Never substitute a parent folder or discard an owner-selected folder during approval.
- Use `npm run verify:core` with a dedicated test database and `npm run verify:macos` for the automated CI profiles. Focused tests are useful during development; unavailable or skipped required checks prevent a full-verification claim.
- Before an app handoff, identify the exact candidate and run its affected live journeys, permission readiness and clean shutdown checks. Record versions, outcomes and remaining gaps. A later source/build/runtime change requires relevant revalidation.
- New asynchronous repository methods must be registered in the storage worker; the `AsyncRepositoryMethod` exhaustiveness check is mandatory. Exercise the real worker RPC for a new async boundary.
- A queued task resolves authorized predecessor context when execution begins. Host-only status/receipt runs must preserve the engine identity of pending approvals. Persist input and cancellation intent before effects; reconcile conversion and cancellation atomically.
- Voice interruption is separate from task cancellation. Test real worker lifecycle: mute/interrupt must not leave an open call with a dead ASR/TTS process. Local synthesis failure never replays a completed task.
- Treat the reviewed folder selection as the target of that approval, even when it replaces the original hint. Never ask for the abandoned hint again merely because the selected folder differs.
- Keep regressions for real failures. Separate prompt-tuning examples from held-out behavioral evaluation. Repeated failures at one boundary require a contract/design review, not only more prompt examples.

## Pull request verification

- Before opening a PR, run the checks in `.github/workflows/ci.yml`, including the full test suite with `LOCAL_TEST_DATABASE_URL` pointing to a dedicated test database. Do not use owner application data for tests.
- Push the verified commit and wait for its GitHub Actions checks to pass before opening the PR. After opening or updating a PR, inspect both push and pull-request checks for the current commit and resolve failures before reporting it ready.
- Report skipped or unavailable checks explicitly. A passing local run or one passing Actions run does not establish that every required check passed.

## Product design: less is more

- Prefer small, simple interfaces with fewer words, controls, and steps.
- Show only what the user needs to make the current decision. Remove repeated explanations, decorative sections, and implementation details.
- Use clear defaults from the user's request. Ask the user to choose manually only when a reliable default cannot be found; allow changing the default.
- Keep consequential choices explicit: show the actual folder and access level before approval. A default is a proposal, not permission.
- Reuse existing interaction patterns and keep routine communication concise.

## Unfamiliar dependencies

Before installing, building, or running an unfamiliar third-party package, check its upstream source and maintainer, the exact revision, known security advisories, dependencies, build scripts/plugins, and any precompiled downloads. Explain why it is needed and record material risks or unverified areas before execution. A trusted package manager, checksum, or lack of reported vulnerabilities does not establish that a package is safe.

Use pinned versions and the least access needed for evaluation. Public dependencies must not require granting Keychain access or supplying credentials. Apply this review before installation, even when the owner has already authorized the feature or package.

- Behavioral qualification must pair observed effects with an independent semantic review of the current run. Broad keyword matches cannot prove truthful outcomes. Coding fixtures need explicit behavior, positive/negative/boundary checks, unchanged test files and observed failing-then-passing execution; a single satisfying example is insufficient.

- Qualification must include the desktop tool catalog, even for ordinary chat. Preserve real schemas when substituting OS effects, and test serialization separately from runtime argument validation.
