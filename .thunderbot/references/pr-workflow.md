# PR Workflow Reference

Protocols for creating, finalizing, and maintaining pull requests. Covers draft creation, CI monitoring, review comment processing, and the fix loop. Used during ThunderBot's autonomous workflow (Phases 8-10) and by `/thunderfix`.

## Contents

1. PR Creation (Draft) — template, title format, parallel PR prep subagents
2. PR Finalization — mark ready, update Linear status
3. CI Monitoring & Fix Loop — watch, diagnose, fix, retry (max 3 attempts)
4. Review Comment Processing — batch collection, fix-all-before-push, reply/resolve protocol
5. Report — summary of fixes and final status

---

## PR Creation (Draft)

After the first meaningful commit has been pushed via `/thunderpush`:

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

`⚡ <IDENTIFIER>: <concise description>` -- for example: `⚡ THU-303: add email notification preferences`

Save the PR number for all subsequent steps:

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
```

### Subagent Pattern: Parallel PR Prep

Launch in parallel before creating the PR:

```
[Agent 1 - PR Description Drafter] model: "sonnet"
prompt: "Read the git log and diff for this branch. Draft a PR description with Summary,
Test Plan, and Changes sections. Output markdown only."

[Agent 2 - Test Suite Runner] model: "sonnet", run_in_background: true
prompt: "Run `bun test` and `cd backend && bun test`. Report pass/fail summary."
```

Use the drafter's output for the PR body. Confirm tests pass before creating.

---

## PR Finalization

When implementation is complete and CI is green:

```bash
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
gh pr ready "$PR_NUMBER"

linear issue comment add <IDENTIFIER> --body "[Thunderbot] PR ready for review: $(gh pr view $PR_NUMBER --json url --jq '.url')"
linear issue update <IDENTIFIER> --state "In Review"
```

---

## CI Monitoring & Fix Loop

### Watch CI

```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

### On CI Failure (max 3 attempts per loop iteration)

1. **Read failing logs:**
   ```bash
   bun run .thunderbot/cli.ts ci-logs --branch "$(git branch --show-current)"
   ```

2. **Analyze the failure.** Launch a CI-Fix subagent for complex failures:
   ```
   model: "sonnet"
   prompt: "Read these CI logs and identify the root cause of the failure.
   Report: (1) which step failed, (2) the error message, (3) the file and line causing it,
   (4) a specific fix recommendation. Do not modify any files.

   <ci-logs>
   {FAILING_LOG_OUTPUT}
   </ci-logs>"
   ```

3. **Fix the issue** in code.

4. **Push the fix:**
   ```
   Skill(skill="thunderpush", args="fix CI failure")
   ```

5. **Wait for CI again:**
   ```bash
   gh pr checks "$PR_NUMBER" --watch --fail-fast
   ```

If CI still fails after 3 attempts, stop and report the failure with full context.

---

## Review Comment Processing

When review comments appear on a PR, process them in a single batch. Do not push between individual fixes.

### Step 1: Collect All Issues in One Pass

```bash
# Get unresolved review threads with full comment details
UNRESOLVED_THREADS=$(bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --unresolved --json)

# Get actionable issue-level comments (excludes bot messages and ⚡-prefixed replies)
ISSUE_COMMENTS=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json)

# CI status
bun run .thunderbot/cli.ts ci-status --pr $PR_NUMBER
```

### Step 2: Fix All Issues (Batch)

Fix everything before pushing. For each unresolved review thread:

- Read the comment and surrounding code context
- Fix legitimate bugs, violations, and requested changes
- Ignore pure style nits and subjective preferences unless the reviewer insists
- Track threads that contain questions, suggestions, or alternative approaches -- you must reply to these before resolving

For issue-level comments:
- Address actionable feedback the same way
- Track comments that pose questions -- you must reply

#### Commit Type for Fixes

These fixes address feedback on the current PR, not pre-existing bugs. Use `chore:`, `refactor:`, or the type matching the original change. Never use `fix:` (reserved for bugs that existed on main).

After fixing all issues, push once:

```
Skill(skill="thunderpush", args="address PR review feedback")
```

If no issues were found (no unresolved threads, no actionable comments, CI passing), skip directly to Verify Clean.

### Step 3: Wait for CI

```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

Handle failures per the CI Monitoring section above (max 3 attempts).

### Step 4: Reply, Resolve, and Mark Complete

After CI passes, reply to every comment that asked a question or proposed an alternative, then resolve.

#### Reply to Review Threads

For each thread containing a question, suggestion, or alternative:

```bash
# Reply before resolving (use the first comment's databaseId from the thread)
bun run .thunderbot/cli.ts pr-reply --pr $PR_NUMBER --comment-id {COMMENT_ID} --body "⚡ <your reply>"
```

**Reply guidelines:**
- Answer questions directly and concisely
- If you adopted a suggestion: "Good call -- done in the latest push."
- If you declined a suggestion: "Considered this, but X because Y. Happy to revisit if you feel strongly."
- If a comment was a pure bug report with no question, replying is optional -- resolving is sufficient
- Prefix all replies with `⚡` so they are filtered out of future counts

#### Resolve Review Threads

```bash
bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --resolve-all
```

#### Reply to and Minimize Issue-Level Comments

For each actionable issue comment: reply first (answering questions), then minimize.

```bash
# Reply
gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X POST -f body="⚡ <your reply>"

# Minimize all actionable comments
bun run .thunderbot/cli.ts pr-minimize --pr $PR_NUMBER
```

### Step 5: Verify Clean

Poll every 15 seconds (max 3 minutes) for new issues:

```bash
PREV_ISSUE_COUNT=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json | jq 'length')

for i in $(seq 1 12); do
  NEW_THREADS=$(bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --json)
  NEW_UNRESOLVED=$(echo "$NEW_THREADS" | jq '.unresolved')

  NEW_ISSUE_COMMENTS=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json | jq 'length')

  if [ "$NEW_UNRESOLVED" -gt 0 ] || [ "$NEW_ISSUE_COMMENTS" -gt "$PREV_ISSUE_COUNT" ]; then
    break  # New issues found -- loop back to Step 1
  fi
  sleep 15
done
```

- **New issues found**: Continue the loop (back to Step 1)
- **No new issues after 3 minutes**: The PR is clean. Stop polling immediately.

Review comments only appear as a result of actions (pushes). Once a clean verification passes, there is nothing more to wait for.

---

## Continuous Monitoring with /loop

After submitting a PR, use `/loop 5m /thunderfix` for continuous monitoring instead of staying in a tight polling loop. Each iteration spawns a fresh context, avoiding context rot in long-running sessions.

### When to Use /loop vs Inline Polling

| Approach | When to use |
|---|---|
| `/loop 5m /thunderfix` | Interactive use -- you want to keep monitoring while doing other work |
| Inline polling (Verify Clean loop above) | Autonomous ThunderBot runs where the agent needs to stay in control of the full fix cycle |

The inline polling loop remains the default for autonomous mode. `/loop` is an alternative for interactive and long-running monitoring scenarios.

### Common Patterns

- **`/loop 5m /thunderfix`** -- monitor a PR for review comments and CI failures every 5 minutes
- **`/loop 3m /thundercheck`** -- continuous quality checking during implementation
- **`/loop 10m /thunderbot`** -- lightweight alternative to the daemon for periodic task polling

### Benefits Over Inline Polling

- **Fresh context per iteration** -- no context rot from accumulating state across many cycles
- **Survives context compaction** -- each run is independent, so compaction between iterations is harmless
- **Composable with any command** -- works with `/thunderfix`, `/thundercheck`, `/thunderbot`, or any other skill
- **Separates "what" from "when"** -- the monitored command stays simple; the schedule is handled externally

---

## Report

After the fix loop completes, print a summary:

- Review thread comments fixed
- Issue-level comments addressed
- CI failures fixed
- Final CI status
- Whether the PR is clean
