---
context: fork
description: "Poll CI status and check for new PR comments"
---

Single poll iteration: check for new comments and CI status on a PR.

## Input

`$ARGUMENTS` = `"<PR_NUMBER> <REPO> <PREV_THREAD_COUNT> <PREV_COMMENT_COUNT>"`

```bash
PR_NUMBER=$(echo "$ARGUMENTS" | awk '{print $1}')
REPO=$(echo "$ARGUMENTS" | awk '{print $2}')
PREV_THREAD_COUNT=$(echo "$ARGUMENTS" | awk '{print $3}')
PREV_COMMENT_COUNT=$(echo "$ARGUMENTS" | awk '{print $4}')
```

## GraphQL Setup

```bash
GQL_DIR=$(mktemp -d)
trap 'rm -rf "$GQL_DIR"' EXIT

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

cat > "$GQL_DIR/issue_comments.jq" << 'JQ'
[.[] | select(
  (.body | startswith("[Thunderbot]") or startswith("\u26a1") | not)
)]
JQ
```

## Check

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

# Current unresolved thread count
THREAD_COUNT=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" \
  --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length')

# Current issue comment count
COMMENT_COUNT=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq" | jq 'length')

# CI status
gh pr checks "$PR_NUMBER"
```

## Output

Print exactly these structured lines (the orchestrator parses them):

```
THREAD_COUNT=<current count>
COMMENT_COUNT=<current count>
NEW_COMMENTS=yes|no
CI=pass|fail|pending
```

`NEW_COMMENTS=yes` if `THREAD_COUNT > PREV_THREAD_COUNT` or `COMMENT_COUNT > PREV_COMMENT_COUNT`.

`CI` is `pass` if all checks passed, `fail` if any failed and none are still running, `pending` if any are still running.
