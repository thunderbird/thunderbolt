Create a git worktree from a branch name or Linear ticket. Argument is passed via $ARGUMENTS.

**Steps:**

1. If `$ARGUMENTS` is empty, ask the user for a branch name or ticket ID.

2. If the argument matches `THU-\d+` (case-insensitive):
   - Run `linear issue view <id> --json --no-pager` to get issue details
   - Extract the `branchName` field from the JSON response
   - Use that as the branch name
   - Report the ticket title and branch name

3. `git fetch origin`

4. Check if the branch exists on remote: `git branch -r --list "origin/<branch>"`

5. Determine the worktree directory name (use the branch name, replacing `/` with `-`):
   - If the remote branch exists: `git worktree add .claude/worktrees/<dir> origin/<branch>`
   - If not: `git worktree add .claude/worktrees/<dir> -b <branch>`

6. Report:
   - Worktree path
   - Branch name
   - Whether it was created from remote or as a new branch
   - Ticket info (if applicable)
