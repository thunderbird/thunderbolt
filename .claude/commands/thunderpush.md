---
disable-model-invocation: true
context: fork
description: "Stage, commit, and push changes"
---

Stage, commit (atomic, conventional), and push all current changes.

## Steps

1. **Inspect changes** — run `git status` (never use `-uall`) and `git diff --staged` / `git diff` to understand what changed. Also run `git log --oneline -5` to match the repo's commit style.

2. **Stage files** — add all relevant changed/untracked files by name. Never use `git add -A` or `git add .`. Never stage files that contain secrets (`.env`, credentials, keys).

3. **Write a conventional commit message** — use the format `type: short description` where type is one of: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `ci`, `build`. Use `fix` only for bugs that existed before the current branch (i.e., bugs present on main). For fixing something you broke or introduced on the current branch, use `chore`, `refactor`, or the type that matches the original change. If the changes relate to a Linear ticket (e.g., `THU-123`), include it: `feat(THU-123): short description`. Keep the subject under 72 characters. Add a body with bullet points if the change is non-trivial. Focus on the "why", not the "what".

4. **Commit** — use a HEREDOC for the message:
   ```bash
   git commit -m "$(cat <<'EOF'
   type: subject line

   - detail if needed
   EOF
   )"
   ```

5. **Push** — push to the current branch's remote tracking branch. If no upstream is set, push with `-u origin <branch>`.

6. **Verify** — run `git status` after push to confirm clean state.

## Rules

- One atomic commit per invocation. If changes span unrelated concerns, ask the user whether to split into multiple commits.
- Never amend existing commits.
- Never force push.
- Never skip pre-commit hooks (`--no-verify`).
- If a pre-commit hook fails, fix the issue and create a new commit (don't amend).
- If `$ARGUMENTS` contains text, use it as guidance for the commit message.
