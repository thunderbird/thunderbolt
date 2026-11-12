---
name: thunderpush
description: Stage, commit and push changes in Thunderbolt as one atomic conventional commit - the only sanctioned way to git add, commit or push here. Use whenever work needs committing or pushing.
---

Stage, commit (atomic, conventional) and push the current changes.

The text after the skill name is guidance for the commit message. It may also name a target checkout (an absolute worktree path); then run every git command below as `git -C <path> ...`.

**Read [commit-conventions.md](references/commit-conventions.md) before writing the message.** It holds the format, the types, the `fix:` rule and examples.

## Steps

1. **Inspect**: `git status` (never `-uall`), `git diff --staged`, `git diff`, and `git log --oneline -5` to match the repo's style.
2. **Stage by name**: add each relevant changed or untracked file by path; `git add -A` and `git add .` stay out. Leave out files holding secrets (`.env`, credentials, keys).
3. **Write the message** per the conventions: `type(THU-123): subject` with a Linear ticket, `type: subject` without one, subject under 72 characters, a bullet body when the change is non-trivial.
4. **Commit** with a HEREDOC:
   ```bash
   git commit -m "$(cat <<'EOF'
   type: subject line

   - detail if needed
   EOF
   )"
   ```
5. **Push** to the branch's upstream; with no upstream, `git push -u origin <branch>`.
6. **Verify**: `git status` shows a clean state after the push.

## Rules

- One atomic commit per invocation. When the changes span unrelated concerns, ask the user (in chat, and wait) whether to split them.
- Every commit is new: no amend, no force push, no `--no-verify`. If a pre-commit hook fails, fix the cause and commit again.
