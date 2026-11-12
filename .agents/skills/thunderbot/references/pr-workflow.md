# PR Workflow Reference

Creating and finalizing ThunderBot's pull requests (Phases 8-9). The CI and review fix loop (Phase 10) lives in one place, the `thunderfix` skill.

---

## PR Creation (Draft)

After the first meaningful commit has been pushed with `thunderpush`:

```bash
cd "$WORKTREE_PATH"

gh pr create --draft \
  --title "⚡ <IDENTIFIER>: <concise title>" \
  --body "$(cat <<'EOF'
## Summary
<2-3 bullet points of what changed and why>

## Linear
[<IDENTIFIER>](<linear-task-url>)

## Test Plan
- [ ] <how to verify the change works>
- [ ] <edge cases tested>

## Changes
<brief list of files changed and their purpose>
EOF
)"
```

### Title Format

`⚡ <IDENTIFIER>: <concise description>`, for example `⚡ THU-303: add email notification preferences`.

Save the PR number for all subsequent steps:

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
```

### Parallel PR Prep

Before creating the PR, dispatch two subagents in parallel (model and effort per the [subagent playbook](subagent-playbook.md)):

```
[PR Description Drafter]
prompt: "Read the git log and diff for this branch. Draft a PR description with Summary,
Test Plan, and Changes sections. Output markdown only."

[Test Suite Runner, in the background]
prompt: "Run `bun run test` and `bun run test:backend`. Report pass/fail summary."
```

Use the drafter's output for the PR body. Confirm the tests pass before creating the PR.

---

## PR Finalization

When implementation is complete and CI is green:

```bash
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
gh pr ready "$PR_NUMBER"

linear issue comment add <IDENTIFIER> --body "[Thunderbot] PR ready for review: $(gh pr view $PR_NUMBER --json url --jq '.url')"
linear issue update <IDENTIFIER> --state "In Review"
```

Then run the `thunderfix` skill for CI and review feedback.
