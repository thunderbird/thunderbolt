---
description: "Enter work context (worktree, deps, or bootstrap)"
---

Enter a work context. Creates a worktree, installs deps, or bootstraps the full dev environment. Argument is passed via $ARGUMENTS.

**Argument parsing:**

- **`up`:** Delegate to `/thunderup` (full bootstrap: doctor, setup, docker, status).
- **`up all`:** Delegate to `/thunderup all` (full bootstrap + dev servers).
- **`setup`:** Run `make setup` to install frontend and backend dependencies.
- **Empty:** Ask the user for a branch name or ticket ID, then create a worktree (see below).
- **Matches `THU-\d+`** (Linear ticket): Create a worktree for the ticket branch (see below).
- **Anything else** (branch name): Create a worktree for that branch (see below).

**Worktree creation steps:**

**Pre-check:** If you're already in a worktree (check: `git rev-parse --git-dir` contains `/worktrees/`), stop and tell the user to run `/thunderout` first. Creating a worktree from inside another worktree causes path and branch conflicts.

1. If the argument matches `THU-\d+` (case-insensitive):
   - Run `linear issue view <id> --json --no-pager` to get issue details
   - Extract the `branchName` field from the JSON response
   - Use that as the branch name
   - Report the ticket title and branch name

2. `git fetch origin`

3. Check if the branch exists on remote: `git branch -r --list "origin/<branch>"`

4. Determine the worktree directory name (use the branch name, replacing `/` with `-`):
   - If the remote branch exists: `git worktree add .claude/worktrees/<dir> origin/<branch>`
   - If not: `git worktree add .claude/worktrees/<dir> -b <branch>`

5. If the worktree already exists at the target path, skip creation and pull the latest from the remote:
   - `cd` into the worktree directory
   - `git pull` to get the latest changes

6. Report:
   - Worktree path
   - Branch name
   - Whether it was created from remote, as a new branch, or already existed
   - Ticket info (if applicable)

7. Tell the user to exit and restart Claude Code from the worktree:
   ```
   cd <worktree-path>
   claude
   ```
   Note: `cd` does not persist across Bash tool calls, so the session's working directory cannot be changed mid-session.
