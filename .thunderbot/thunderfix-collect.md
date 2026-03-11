---
context: fork
description: "Collect PR review threads, issue comments, and CI status"
---

Collect all unresolved review threads, issue-level comments, and CI status for a PR. Write results to a state file.

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

cat > "$GQL_DIR/issue_comments.jq" << 'JQ'
[.[] | select(
  (.body | startswith("[Thunderbot]") or startswith("\u26a1") | not)
)]
JQ
```

## Collect Data

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

# Unresolved review threads (full detail)
UNRESOLVED_THREADS=$(gh api graphql -F "query=@$GQL_DIR/threads.graphql" -f "id=$PR_NODE_ID" \
  --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)]')

# Issue-level comments (filtered)
ISSUE_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" | jq -f "$GQL_DIR/issue_comments.jq")

# CI status
CI_OUTPUT=$(gh pr checks "$PR_NUMBER" 2>&1 || true)
```

## Write State File

```bash
jq -n \
  --arg pr_node_id "$PR_NODE_ID" \
  --argjson threads "$UNRESOLVED_THREADS" \
  --argjson issue_comments "$ISSUE_COMMENTS" \
  --arg ci_output "$CI_OUTPUT" \
  '{pr_node_id: $pr_node_id, threads: $threads, issue_comments: $issue_comments, ci_output: $ci_output}' \
  > "/tmp/thunderfix-$PR_NUMBER-state.json"
```

## Output

Print a structured summary:

- `THREADS=<count>` — number of unresolved review threads
- `COMMENTS=<count>` — number of issue-level comments
- `CI=pass|fail|pending` — CI status (pass if all checks passed, fail if any failed, pending if any still running)
- `STATE_FILE=/tmp/thunderfix-$PR_NUMBER-state.json`

Then print a brief human-readable description of what was found (thread topics, comment authors, which CI checks failed).
