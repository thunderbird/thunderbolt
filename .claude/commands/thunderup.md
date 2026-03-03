Bootstrap the Thunderbolt dev environment. Accepts an optional argument via $ARGUMENTS.

**Argument parsing:**

- **Empty (default):** Run the standard bootstrap:
  1. `make doctor` — verify tools
  2. `make setup` — install frontend + backend deps
  3. `make docker-up` — start docker containers
  4. `make docker-status` — confirm containers are healthy

- **`all`:** Run the standard bootstrap above, then also:
  5. `make run` — start backend (:8000) and frontend (:5173) dev servers

- **Matches `THU-\d+`** (Linear ticket): Create a worktree for the ticket branch first, then run the standard bootstrap inside that worktree:
  1. Run `linear issue view <id> --json --no-pager` to get the branch name
  2. `git fetch origin`
  3. If the branch exists on remote: `git worktree add .claude/worktrees/<dir> origin/<branch>`
  4. If not: `git worktree add .claude/worktrees/<dir> -b <branch>`
  5. cd into the worktree, then run the standard bootstrap steps

- **Anything else** (branch name): Create a worktree for that branch, then run the standard bootstrap inside:
  1. `git fetch origin`
  2. If the branch exists on remote: `git worktree add .claude/worktrees/<dir> origin/<branch>`
  3. If not: `git worktree add .claude/worktrees/<dir> -b <branch>`
  4. cd into the worktree, then run the standard bootstrap steps

Run each step sequentially. If `make doctor` reports critical failures, stop and report — don't continue the bootstrap.
