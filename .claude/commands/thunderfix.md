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
        nodes { id isResolved comments(first: 10) { nodes { body path line author { login } } } }
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
```

## Fix Loop

Run this loop. Track elapsed time — stop after **15 minutes** total.

### 1. Collect All Issues

Gather everything that needs attention in one pass:

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

# Review thread comments (code-level)
UNRESOLVED_THREADS=$(gh api graphql -F "query=@$GQL_DIR/threads.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false)')

# Issue-level comments (non-code PR comments from reviewers, not from the PR author)
PR_AUTHOR=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.user.login')
ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --jq --arg author "$PR_AUTHOR" '[.[] | select(.user.login != $author and (.body | test("^\\[Thunderbot\\]") | not))]')

# CI status
gh pr checks "$PR_NUMBER"
```

### 2. Fix All Issues (Batch)

**Fix everything before pushing.** Do NOT push between individual fixes.

#### Review thread comments
Read each unresolved review thread. Fix legitimate bugs, violations, and requested changes. Ignore pure style nits and subjective preferences unless the reviewer insists.

#### Issue-level comments
Read issue-level comments from reviewers. These are general PR feedback not attached to specific code lines. Address actionable feedback the same as review thread comments.

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

### 4. Resolve & Mark Complete

After CI passes, resolve ALL addressed items:

#### Resolve review threads
```bash
THREAD_IDS=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false) | .id')

for THREAD_ID in $THREAD_IDS; do
  gh api graphql -F "query=@$GQL_DIR/resolve.graphql" -f "id=$THREAD_ID"
done
```

#### Acknowledge issue-level comments
For each issue comment that was addressed, reply to confirm:
```bash
gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X POST -f body="Addressed in the latest push."
```

Only reply once per fix cycle, not per comment. If multiple comments were addressed, one reply covering all of them is fine.

### 5. Verify Clean

Poll to verify no new issues appear. Check every **15 seconds** (max **3 minutes**):

```bash
for i in $(seq 1 12); do
  NEW_UNRESOLVED=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length')

  NEW_ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --jq --arg author "$PR_AUTHOR" '[.[] | select(.user.login != $author and (.body | test("^\\[Thunderbot\\]|^Addressed") | not))] | length')

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
