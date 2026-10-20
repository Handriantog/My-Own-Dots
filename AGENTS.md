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
