---
context: fork
description: "Reply to review threads, resolve them, and minimize issue comments"
---

Reply to and resolve all unresolved review threads, then minimize all issue-level comments on a PR. This skill is self-contained — it fetches its own fresh data.

## Input

`$ARGUMENTS` = `"<PR_NUMBER> <REPO>"`

```bash
PR_NUMBER=$(echo "$ARGUMENTS" | awk '{print $1}')
REPO=$(echo "$ARGUMENTS" | awk '{print $2}')
```

## GraphQL Setup

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

cat > "$GQL_DIR/issue_comments.jq" << 'JQ'
[.[] | select(
  (.body | startswith("[Thunderbot]") or startswith("\u26a1") | not)
)]
JQ
```

## Gather Context

Read the state file for background context on what was collected:

```bash
cat "/tmp/thunderfix-$PR_NUMBER-state.json"
```

Read the most recent diff to understand what was just fixed:

```bash
git diff HEAD~1
```

## Fetch Fresh Data

Fetch current unresolved threads and issue comments (not stale data from the state file):

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

UNRESOLVED_THREADS=$(gh api graphql -F "query=@$GQL_DIR/threads.graphql" -f "id=$PR_NODE_ID" \
  --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)]')

ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq")
```

## Reply & Resolve Review Threads

For each unresolved review thread:

1. Read the reviewer's comment body, file path, and line number
2. Understand what changed in the diff that addresses it
3. Generate a concise reply:
   - Answer questions directly
   - If you adopted a suggestion: "Good call — done in the latest push."
   - If you declined a suggestion: explain why briefly
   - If it's a pure bug report with no question: reply is optional
   - **Prefix all replies with ⚡** so they're filtered from future counts
4. Post the reply via REST API (using the first comment's `databaseId`):
   ```bash
   gh api "repos/$REPO/pulls/$PR_NUMBER/comments/{COMMENT_DATABASE_ID}/replies" -X POST -f body="⚡ <reply>"
   ```
5. Resolve the thread via GraphQL:
   ```bash
   gh api graphql -F "query=@$GQL_DIR/resolve.graphql" -f "id=$THREAD_ID"
   ```

Only resolve/reply to threads that were actually addressed. If a comment was skipped or deferred, leave it unresolved.

## Reply & Minimize Issue Comments

For each issue-level comment:

1. If the comment asked a question or proposed an alternative, reply first:
   ```bash
   gh api "repos/$REPO/issues/$PR_NUMBER/comments" -X POST -f body="⚡ <reply>"
   ```
2. **Minimize every collected issue comment** (unconditional — this collapses resolved feedback):
   ```bash
   # Get fresh comment node IDs
   COMMENT_NODE_IDS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq" | jq -r '.[].node_id')
   for COMMENT_ID in $COMMENT_NODE_IDS; do
     gh api graphql -F "query=@$GQL_DIR/minimize.graphql" -f "id=$COMMENT_ID"
   done
   ```

## Output

Print a summary:
- How many review threads were replied to and resolved
- How many issue comments were replied to and minimized
