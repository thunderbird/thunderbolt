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

## GraphQL Helper

All GraphQL queries use `$id` variables that conflict with shell expansion. Write queries to a temp file and load with `-F`:

```bash
GQL_DIR=$(mktemp -d)
trap 'rm -rf "$GQL_DIR"' EXIT

cat > "$GQL_DIR/threads.graphql" << 'GQL'
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 10) { nodes { id databaseId body path line author { login } } } }
      }
    }
  }
}
GQL

cat > "$GQL_DIR/threads_summary.graphql" << 'GQL'
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved }
      }
    }
  }
}
GQL

cat > "$GQL_DIR/resolve.graphql" << 'GQL'
mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) {
    thread { id }
  }
}
GQL

cat > "$GQL_DIR/minimize.graphql" << 'GQL'
mutation($id: ID!) {
  minimizeComment(input: {subjectId: $id, classifier: RESOLVED}) {
    minimizedComment { isMinimized }
  }
}
GQL

# jq filter for actionable issue comments (include bot comments too).
# Does NOT filter by PR author — in thunderbot flows the human IS the PR author,
# so their review feedback must be included.
# Written to a file because operators are mangled by shell expansion in inline jq.
cat > "$GQL_DIR/issue_comments.jq" << 'JQ'
[.[] | select(
  (.body | startswith("[Thunderbot]") or startswith("⚡") | not)
)]
JQ
```

## Fix Loop

Run this loop. Track elapsed time — stop after **15 minutes** total.

### 1. Collect All Issues

Gather everything that needs attention in one pass:

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

# Review thread comments (code-level)
UNRESOLVED_THREADS=$(gh api graphql -F "query=@$GQL_DIR/threads.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false)')

# Issue-level comments (non-code PR comments from humans, excluding bot messages)
ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq")

# CI status
gh pr checks "$PR_NUMBER"
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

If CI fails (max **3 CI fix attempts** per loop iteration):
1. Read failing logs:
   ```bash
   gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log-failed
   ```
2. Fix the issue
3. Push: `Skill(skill="thunderpush", args="fix CI failure")`
4. Wait for CI again

If CI still fails after 3 attempts, stop and report the failure.

### 4. Reply, Resolve & Mark Complete

After CI passes, **reply to every comment that asked a question or proposed an alternative**, then resolve.

#### Reply to review threads

For each unresolved review thread that contained a question, suggestion, or alternative approach: reply **before** resolving. Use the REST API to reply to the thread (the comment ID is the first comment's `id` from the thread's `comments.nodes[0]`):

```bash
# For each thread that needs a reply, get the numeric comment ID from the
# GraphQL `id` field of the first comment (it's also available via REST).
# Then reply:
gh api "repos/$REPO/pulls/$PR_NUMBER/comments/{COMMENT_ID}/replies" -X POST -f body="<your reply>"
```

**Reply guidelines:**
- Answer questions directly and concisely
- If you adopted a suggestion, say so briefly (e.g., "Good call — done in the latest push.")
- If you considered but declined a suggestion, explain why (e.g., "Considered this, but X because Y. Happy to revisit if you feel strongly.")
- If a comment was a pure bug report with no question, a reply is optional — resolving is sufficient
- Prefix replies with ⚡ so they're filtered out of future counts

#### Resolve review threads
```bash
THREAD_IDS=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false) | .id')

for THREAD_ID in $THREAD_IDS; do
  gh api graphql -F "query=@$GQL_DIR/resolve.graphql" -f "id=$THREAD_ID"
done
```

#### Reply to and minimize issue-level comments

For each actionable issue comment: reply first (answering any questions), then minimize.

```bash
# Get comments that need replies
ISSUE_COMMENT_DATA=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq")

# For each comment, reply if it contained a question or suggestion:
# gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X POST -f body="⚡ <your reply>"

# Then minimize
COMMENT_NODE_IDS=$(echo "$ISSUE_COMMENT_DATA" | jq -r '.[].node_id')

for COMMENT_ID in $COMMENT_NODE_IDS; do
  gh api graphql -F "query=@$GQL_DIR/minimize.graphql" -f "id=$COMMENT_ID"
done
```

### 5. Verify Clean

Poll to verify no new issues appear. Check every **15 seconds** (max **3 minutes**):

```bash
PREV_ISSUE_COUNT=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq" | jq 'length')

for i in $(seq 1 12); do
  NEW_UNRESOLVED=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length')

  NEW_ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq" | jq 'length')

  if [ "$NEW_UNRESOLVED" -gt 0 ] || [ "$NEW_ISSUE_COMMENTS" -gt "$PREV_ISSUE_COUNT" ]; then
    break  # New issues found — loop back to step 1
  fi
  sleep 15
done
```

- If new issues found: **continue the loop** (back to step 1)
- If no new issues after 3 minutes: **done** — the PR is clean. Stop polling immediately.

Do NOT continue polling once the PR is verified clean. Review comments only appear as a result of actions (pushes), so once a clean verification passes, there's nothing more to wait for.

## Cleanup

```bash
rm -rf "$GQL_DIR"
```

## Report

Print a summary:
- How many review thread comments were fixed
- How many issue-level comments were addressed
- How many CI failures were fixed
- Final CI status
- Whether the PR is clean
