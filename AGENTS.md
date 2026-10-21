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

## Product design: less is more

- Prefer small, simple interfaces with fewer words, controls, and steps.
- Show only what the user needs to make the current decision. Remove repeated explanations, decorative sections, and implementation details.
- Use clear defaults from the user's request. Ask the user to choose manually only when a reliable default cannot be found; allow changing the default.
- Keep consequential choices explicit: show the actual folder and access level before approval. A default is a proposal, not permission.
- Reuse existing interaction patterns and keep routine communication concise.

## Unfamiliar dependencies

Before installing, building, or running an unfamiliar third-party package, check its upstream source and maintainer, the exact revision, known security advisories, dependencies, build scripts/plugins, and any precompiled downloads. Explain why it is needed and record material risks or unverified areas before execution. A trusted package manager, checksum, or lack of reported vulnerabilities does not establish that a package is safe.

Use pinned versions and the least access needed for evaluation. Public dependencies must not require granting Keychain access or supplying credentials. Apply this review before installation, even when the owner has already authorized the feature or package.
