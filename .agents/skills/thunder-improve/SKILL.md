---
name: thunder-improve
description: Review the current branch's changes with thunder-deep-review and, when asked, fix what it finds, then re-run the checks. Use for "review and fix my changes", "improve this branch", self-review before opening a PR, or the quality gate in thunderbot's implementation loop. For a read-only review only, use thunder-deep-review.
---

Self-review of this branch that can fix what it finds. `thunder-deep-review` does the reviewing; this skill adds the fix-and-verify loop around it.

## 1. Choose the mode

Ask once:

1. **Report only** — the review, zero file changes.
2. **Auto-fix** — apply findings with an obvious mechanical fix, ask before judgment calls.

When the caller already chose (for example thunderbot runs it as auto-fix), skip the question.

## 2. Review

Run `thunder-deep-review` in local mode on the branch diff: committed (`git diff $(git merge-base HEAD main)..HEAD`), staged and unstaged changes together. Its report, with severity and confidence per finding, is this step's output. In report-only mode, show the report and stop.

## 3. Fix (auto-fix only)

Sort the findings into two lists and show both:

- **Mechanical** — the fix is one obvious edit inside a file in the diff: `interface` → `type`, `function` → arrow, `let` → `const` with early return, `.then/.catch` → `async/await`, `React.useEffect` → `useEffect`, an unused import, a missing JSDoc on a new utility. Apply these.
- **Judgment** — anything with more than one reasonable fix, or a fix outside the diff. Ask the user about each before editing.

Edit only files that appear in the branch diff. Before the first edit to a file, copy it to a temporary directory outside the repo; the copy keeps any uncommitted work the user had in it.

## 4. Verify

Run `make check`, then the scoped test command for every workspace you touched, from the Testing table in `AGENTS.md` (`bun run test`, `bun run test:backend`, `cd cli && bun run test`, …). Never run bare `bun test` at the repo root. The step is done when both pass or a failure is reported.

On a failure, show it and offer to revert your edits by restoring each file from its step-3 copy. `git checkout` would also discard the user's uncommitted work, so restore from the copies.

## 5. Report

Findings fixed (`file:line`, what changed), findings left for the user with the reason, and the verification result.
