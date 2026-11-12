---
name: thunderin
description: Enter a Thunderbolt work context - create (or reuse) a git worktree for a THU-n ticket or a branch, install dependencies (`setup`), or bootstrap the stack (`up`, `up all`). Use when starting work on a ticket or branch in its own worktree.
---

Enter a work context. The argument is the text after the skill name:

- **`up`** / **`up all`**: run the `thunderup` skill (with `all` for the second).
- **`setup`**: run `make setup` to install frontend and backend dependencies.
- **Empty**: ask the user for a branch name or ticket ID, then create the worktree.
- **Matches `THU-\d+`** (case-insensitive): the branch comes from Linear; create the worktree.
- **Anything else**: it is a branch name; create the worktree.

## Harness notes

| Action | Claude Code | Any other harness |
|---|---|---|
| Ask the user | AskUserQuestion. | Ask in chat and wait for the reply. |
| Worktree root | `$MAIN/.claude/worktrees` | The harness's own worktree feature if it has one, else `$MAIN/../thunderbolt-worktrees`. |
| Enter the worktree | `EnterWorktree({ path })`, loaded with ToolSearch `select:EnterWorktree`. | Prefix every later shell command with `cd <absolute worktree path> &&`, or tell the user to restart the agent in that directory. |

## Create the worktree

Run git against the main checkout so this works from anywhere, including from inside another worktree:

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
```

1. For a ticket: `linear issue view <id> --json --no-pager` (needs the `linear` CLI, `brew install schpet/tap/linear`) and use its `branchName` field. Report the ticket title and branch.
2. `git -C "$MAIN" fetch origin`
3. Directory name: the branch with `/` replaced by `-`; path: `<worktree root>/<dir>` from Harness notes.
4. If that path is already a worktree, reuse it: `git -C <path> pull`. Otherwise create it with the first command that applies:
   - local branch exists (`git -C "$MAIN" show-ref --verify --quiet refs/heads/<branch>`): `git -C "$MAIN" worktree add <path> <branch>`
   - remote branch exists (`git -C "$MAIN" branch -r --list "origin/<branch>"`): `git -C "$MAIN" worktree add --track -b <branch> <path> origin/<branch>`
   - neither: `git -C "$MAIN" worktree add -b <branch> <path> origin/main`
5. Enter the worktree (Harness notes).
6. Report the worktree path, the branch, whether it was reused, created from the remote, or created as a new branch, and the ticket if any.
