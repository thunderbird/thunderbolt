---
name: thunder-cleanup
description: Remove everything a finished Thunderbolt task left on this machine (worktree, branch, Docker stack, simulators, build caches, validation scratch) to free disk, after its PR merged. Use when a PR merged or a task is done or abandoned, to free disk space, to remove or leave a worktree ("limpar a worktree"), or with `merged` to clean every worktree whose PR merged.
---

# Cleaning up a finished task

Remove what one task created, and only that. Two sources say what belongs to a task:

- The **ledger**, one file per checkout under `<git common dir>/thunder-resources/`, keyed by
  the checkout's path so a branch rename keeps it. Skills that create something outside the
  checkout (a snapshot, a scratch dir, a compose project, a simulator, an AVD, a background
  process) append a line with `scripts/record.sh`, which validates each value; its header
  documents the kinds and the format.
- **Discovery**: compose labels, process working directories, Xcode DerivedData
  `WorkspacePath`, and everything inside the worktree.

`scripts/inventory.sh` reads both and prints one row per item: status, kind, id, size, proof
and the exact removal command. It is read-only. Status is `owned` (ledger or structural),
`probable` (found only by discovery, so the user confirms it), `manual` (out of reach from this
machine, or refused as unsafe) or `info`.

## Argument

- A branch, a worktree path, a PR number or a `THU-n` ticket: one task.
- `merged`: every worktree whose newest PR is merged.
- Nothing: the current worktree.

## Harness notes

| Situation | What to do |
| --- | --- |
| Asking or confirming | Claude Code: AskUserQuestion. Any other harness: print the options as a numbered list and wait for the reply. |
| Running inside the worktree being removed | Its folder disappears under the shell. Run every command from the main checkout (`cd <main checkout> && ...`, absolute paths), and at the end tell the user to start a fresh session in the main checkout (`/clear` in Claude Code). |
| Worktree created by an app (T3 `~/.t3/worktrees/...`, the Codex app, Claude Code `.claude/worktrees/...`) | Git removes it normally, but the app's thread keeps pointing at the deleted folder. Tell the user to archive that thread. |

## Steps

### 1. Identify the task

- PR number: `gh pr view <n> --json headRefName --jq .headRefName` gives the branch.
- `THU-n`: the worktree in `git worktree list` whose branch contains `thu-<n>`, ignoring case. If
  several or none match, ask.
- Path or branch: use it as given.

Done when you hold one branch, or `merged` mode.

### 2. Take the inventory

```bash
cd <main checkout> && bash <absolute path of this skill>/scripts/inventory.sh <worktree path | branch | --merged>
```

The main checkout is the first entry of `git worktree list`. Sizing large worktrees takes a few
seconds each. Done when the output ends with a `# total` line for every task.

### 3. Gate each task

- The `pr` row must say `MERGED`. It counts only same-repo PRs whose head is on the local
  branch's line of history; `MERGED-UNVERIFIED` means a PR with a reused branch name. For
  anything but `MERGED`, stop for that task unless the user says the work was abandoned. The
  inventory refuses the default branch outright.
- `uncommitted` above 0, `unpushed` above 0 or `unknown`, and every `stash` row are work that
  removal destroys. List them and ask whether to keep the task or lose that work.

In `merged` mode, leave a task that fails a gate out of the batch and list it with the reason.
Done when every remaining task passes both gates or has the user's explicit yes.

### 4. Confirm once

Show one table per task with status, kind, id, size and proof, plus the total. Mark `probable`
rows "confirm" and show each process's command line: a recorded pid may have been reused by an
unrelated process, and an agent tool (an MCP bridge, a helper shell) means an agent session is
still open in that worktree, so its thread should be archived. Summarise `worktree-part` rows as the heaviest parts of the worktree. Give
`manual` rows as steps for the user, with where the item lives. Ask once whether to remove
every `owned` and `probable` row; the user may exclude rows by id. Done when you have a yes and
the list of excluded rows.

### 5. Remove

Run the command of each confirmed row as printed, in the order printed: processes, Docker,
simulators and AVDs, DerivedData, snapshot and scratch, worktree, stashes, branch, prune,
ledger. The commands already `cd` where needed, use absolute paths, and run in bash or zsh.

- `git worktree remove` refuses a dirty tree. With the user's yes from step 3, rerun it with
  `--force`.
- `git branch -D` is right here because step 3 saw the PR merged (squash merges leave the branch
  unmerged by ancestry) or the user accepted losing the work.
- When a command fails, note it and continue with the next row.
- Run the `ledger` row last, and only when every other confirmed row succeeded and the user
  excluded none. Otherwise skip it and say why: the ledger is the only record of what is left.
  The inventory already keeps the ledger (an `info` row) while any `manual` row remains.

Done when every confirmed row has run.

### 6. Report

Report the freed space as an estimate (the sum of the sizes of the rows that succeeded; a
recorded path inside another removed path is counted twice) and account for every
inventory row: removed, left with its reason (excluded, failed with the error, manual), or
info. A `remote-branch` row means the branch is still on origin; GitHub deletes merged branches
itself, so report it and leave it there. Done when every row is accounted for.

## Scope

Remove only what the inventory printed and the user confirmed. These stay, even when the user
asks to free more disk: the main checkout, other worktrees, shared caches (bun, cargo,
`~/.gradle`, Playwright browsers, Xcode runtimes), simulators and AVDs the ledger does not list,
`~/.argent/secrets.env`, agent conversation history (`~/.claude/projects`, Codex sessions), the
Linear ticket, and remote branches.

After changing either script, run `bash scripts/test.sh` from this folder.
