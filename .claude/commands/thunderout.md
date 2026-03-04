Leave the current worktree, tear it down, and return to the main repo on the main branch.

**Steps:**

1. **Verify you're in a worktree.** Run `git rev-parse --git-dir` — if the result doesn't contain `/worktrees/`, tell the user they're not in a worktree and stop.

2. **Get the worktree path and main repo path:**
   - Worktree path: `git rev-parse --show-toplevel`
   - Main repo path: `git worktree list --porcelain` — the first entry is the main working tree

3. **Check for uncommitted changes.** Run `git status --porcelain` in the current worktree.
   - If there are uncommitted changes, warn the user and list the changed files
   - Ask whether to proceed (changes will be lost) or abort so they can commit first
   - If the user aborts, stop

4. **Check for unpushed commits.** Run `git log @{upstream}.. --oneline 2>/dev/null` in the current worktree.
   - If there are unpushed commits, warn the user and list them
   - Ask whether to proceed (unpushed commits will be lost) or abort so they can push first
   - If the user aborts, stop

5. **Leave, remove, and switch — all in one command.** The Bash tool's working directory doesn't persist between calls, so run steps 5-7 as a single command to avoid the CWD becoming invalid after the worktree is deleted:
   ```
   cd <main-repo-path> && git worktree remove <worktree-path> && git checkout main
   ```
   - If `git worktree remove` fails (e.g., dirty state after user chose to proceed), retry the entire chained command with `--force`:
     ```
     cd <main-repo-path> && git worktree remove --force <worktree-path> && git checkout main
     ```
   - If the worktree path no longer exists on disk, use `git worktree prune` instead:
     ```
     cd <main-repo-path> && git worktree prune && git checkout main
     ```

6. **Report:**
   - Worktree removed
   - Now on `main` in the main repo

7. After reporting, tell the user to run `/clear` to start with a fresh context.
