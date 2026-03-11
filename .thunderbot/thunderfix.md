---
context: fork
description: "Fix PR review comments and CI failures"
---

Fix all PR issues (review comments + issue comments + CI failures) and monitor until clean.

A PR must already exist on the current branch.

## Setup

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
```

If no PR is found, stop and tell the user.

## Fix Loop

Run this loop. Track elapsed time — stop after **15 minutes** total.

### Steps 1–3: Collect → Fix → Resolve (ALWAYS run all three)

Execute these three steps **in sequence, unconditionally, every iteration**. Never skip a step.

**Step 1 — Collect:**

```
Skill(skill="thunderfix-collect", args="$PR_NUMBER $REPO")
```

Parse the output for thread count, comment count, and CI status. Read `/tmp/thunderfix-$PR_NUMBER-state.json` for full details.

**Step 2 — Fix code:**

Read the state file. Fix legitimate bugs, violations, and requested changes in the code. Ignore pure style nits unless the reviewer insists. Use `chore:` or `refactor:` commit type (never `fix:` — reserved for bugs on main). If changes were made, push once:

```
Skill(skill="thunderpush", args="address PR review feedback")
```

**Step 3 — Resolve & minimize:**

```
Skill(skill="thunderfix-resolve", args="$PR_NUMBER $REPO")
```

This step replies to review threads, resolves them via GraphQL, replies to issue comments, and minimizes them. **You MUST call this skill even if Step 2 made no code changes.** Issue comments still need replies and minimizing. Do NOT proceed to Step 4 until this skill returns.

### 4. Poll CI

Loop (max 3 CI fix attempts, sleep 5s between polls):

```
Skill(skill="thunderfix-poll", args="$PR_NUMBER $REPO $THREAD_COUNT $COMMENT_COUNT")
```

Where `$THREAD_COUNT` and `$COMMENT_COUNT` are the counts from the most recent collect step (i.e., the baseline before new comments would appear).

Handle the output:

- **`NEW_COMMENTS=yes`** → go back to Step 1 (full cycle)
- **`CI=pending`** → sleep 5 seconds, poll again
- **`CI=pass`** → proceed to Step 5
- **`CI=fail`** (attempts < 3):
  1. Read failing logs:
     ```bash
     gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log-failed
     ```
  2. Fix the issue
  3. `Skill(skill="thunderpush", args="fix CI failure")`
  4. `Skill(skill="thunderfix-resolve", args="$PR_NUMBER $REPO")`
  5. Continue polling
- **`CI=fail`** (attempts >= 3): stop and report the failure

### 5. Verify Clean

Loop 12x (every 15s, max 3 minutes):

```
Skill(skill="thunderfix-poll", args="$PR_NUMBER $REPO $THREAD_COUNT $COMMENT_COUNT")
```

- New issues → back to Step 1
- Clean after 3 minutes → done

Do NOT continue polling once verified clean.

## Cleanup

```bash
rm -f "/tmp/thunderfix-$PR_NUMBER-state.json"
```

## Report

Print a summary:
- How many review thread comments were fixed
- How many issue-level comments were addressed
- How many CI failures were fixed
- Final CI status
- Whether the PR is clean
