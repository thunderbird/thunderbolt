---
context: fork
description: "Fix PR review comments and CI failures"
---

For continuous monitoring, consider using `/loop 5m /thunderfix` instead of running this command once. Each loop iteration gets a fresh context.

For enriched PR workflow protocols, read `.thunderbot/references/pr-workflow.md`.

Fix all PR issues (review comments + issue comments + CI failures) and monitor until clean.

A PR must already exist on the current branch.

## Setup

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
```

If no PR is found, stop and tell the user.

## Fix Loop

Run this loop. Track elapsed time — stop after **15 minutes** of actual fixing work. Waiting on CI in step 3 does not count against that budget: `thunder-deep-review` is sized against `timeout-minutes: 30` and is normally the last check to finish, so a single watch can outlast the whole fixing budget on its own.

### 1. Collect All Issues

Gather everything that needs attention in one pass:

```bash
# Get unresolved review threads
UNRESOLVED_THREADS=$(bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --unresolved --json)

# Get actionable issue comments (excludes bot messages and ⚡-prefixed replies)
ISSUE_COMMENTS=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json)

# CI status
bun run .thunderbot/cli.ts ci-status --pr $PR_NUMBER
```

### 2. Fix All Issues (Batch)

**Fix everything before pushing.** Do NOT push between individual fixes.

#### Review thread comments
Read each unresolved review thread. Fix legitimate bugs, violations, and requested changes. Ignore pure style nits and subjective preferences unless the reviewer insists.

**Important:** For each thread, note whether the reviewer asked a question, made a suggestion, or proposed an alternative approach. You will need to **reply** to these before resolving (see Step 4). Track which threads need replies and what the reply should say.

#### Issue-level comments
Read issue-level comments from reviewers. These are general PR feedback not attached to specific code lines. Address actionable feedback the same as review thread comments. If a comment poses a question, you must reply to it (see Step 4).

#### Commit type
When calling `/thunderpush`, these fixes address feedback on the current PR — they are NOT pre-existing bugs. The commit type should match the nature of the fix (usually `chore:` or `refactor:`), never `fix:` (which is reserved for bugs that existed on main before this branch).

After fixing all issues, push once:

```
Skill(skill="thunderpush", args="address PR review feedback")
```

If no issues were found (no unresolved threads, no actionable issue comments, CI passing), skip directly to **Resolve & Mark Complete**.

### 3. Wait for CI

```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

`--watch` waits for **every** check on the PR, including the one named `review` — the single job of `thunder-deep-review`, the advisory, comment-only AI review in `.github/workflows/thunder-deep-review.yml`. It runs on every non-draft same-repo PR (forks and Dependabot are gated off), opens with a 60-second debounce, and is capped at `timeout-minutes: 30`. It posts with `event: 'COMMENT'` only — it never approves, requests changes, or merges — and `main`'s ruleset declares **no** required status checks (only one approving review, linear history, and squash merges), so nothing it reports blocks the merge. Don't reach for `gh pr checks --required` to skip the wait — with no required checks configured, it reports nothing at all.

Treat a `thunder-deep-review` finding as review feedback, not as a CI failure: most findings land as inline review threads that step 1 already collects, so fix them there rather than spending CI fix attempts on them. Findings it cannot anchor to a line in the diff — plus any past its 50-inline-comment cap — roll into the review's summary body instead, which neither `pr-threads` nor `pr-comments` returns (`pr-comments` keeps only `user.type === 'User'`), so read the review itself on the PR as well.

If CI fails (max **3 CI fix attempts** per loop iteration):
1. Read failing logs:
   ```bash
   bun run .thunderbot/cli.ts ci-logs --branch "$(git branch --show-current)"
   ```
2. Fix the issue
3. Push: `Skill(skill="thunderpush", args="fix CI failure")`
4. Wait for CI again

If CI still fails after 3 attempts, stop and report the failure.

### 4. Reply, Resolve & Mark Complete

After CI passes, **reply to every comment that asked a question or proposed an alternative**, then resolve.

#### Reply to review threads

For each unresolved review thread that contained a question, suggestion, or alternative approach: reply **before** resolving. Use the CLI to reply (the comment ID is the first comment's `databaseId` from the thread's `comments.nodes[0]`):

```bash
bun run .thunderbot/cli.ts pr-reply --pr $PR_NUMBER --comment-id {COMMENT_ID} --body "⚡ <your reply>"
```

**Reply guidelines:**
- Answer questions directly and concisely
- If you adopted a suggestion, say so briefly (e.g., "Good call — done in the latest push.")
- If you considered but declined a suggestion, explain why (e.g., "Considered this, but X because Y. Happy to revisit if you feel strongly.")
- If a comment was a pure bug report with no question, a reply is optional — resolving is sufficient
- Prefix replies with ⚡ so they're filtered out of future counts

#### Resolve review threads
```bash
bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --resolve-all
```

#### Reply to and minimize issue-level comments

For each actionable issue comment: reply first (answering any questions), then minimize.

```bash
# Get actionable comments
ISSUE_COMMENT_DATA=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json)

# For each comment, reply if it contained a question or suggestion:
# Reply to each comment via gh api before minimizing

# Minimize all actionable comments
bun run .thunderbot/cli.ts pr-minimize --pr $PR_NUMBER
```

### 5. Verify Clean

Poll to verify no new issues appear. Check every **15 seconds** (max **3 minutes**):

```bash
PREV_ISSUE_COUNT=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json | jq 'length')

for i in $(seq 1 12); do
  NEW_THREADS=$(bun run .thunderbot/cli.ts pr-threads --pr $PR_NUMBER --json)
  NEW_UNRESOLVED=$(echo "$NEW_THREADS" | jq '.unresolved')

  NEW_ISSUE_COMMENTS=$(bun run .thunderbot/cli.ts pr-comments --pr $PR_NUMBER --actionable --json | jq 'length')

  if [ "$NEW_UNRESOLVED" -gt 0 ] || [ "$NEW_ISSUE_COMMENTS" -gt "$PREV_ISSUE_COUNT" ]; then
    break  # New issues found — loop back to step 1
  fi
  sleep 15
done
```

- If new issues found: **continue the loop** (back to step 1)
- If no new issues after 3 minutes: **done** — the PR is clean. Stop polling immediately.

Do NOT continue polling once the PR is verified clean. Review comments only appear as a result of actions (pushes), so once a clean verification passes, there's nothing more to wait for.

## Report

Print a summary:
- How many review thread comments were fixed
- How many issue-level comments were addressed
- How many CI failures were fixed
- Final CI status
- Whether the PR is clean
