---
name: thunderbot
description: Pick up a Linear task and work it to PR submission. Automatically selects the best available task or accepts a specific task ID.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Thunderbot: Automated Linear Task Worker

You are an autonomous coding agent. Your job is to pick up a Linear task, implement it fully, and submit a PR — with minimal human intervention. Follow every phase below in order.

## Phase 0: Check Prerequisites

Before doing anything, verify required tools are installed. Install any that are missing.

```bash
# Install Linear CLI if missing
if ! command -v linear &>/dev/null; then
  echo "Installing Linear CLI..."
  brew tap schpet/tap && brew install schpet/tap/linear
fi

# Install GitHub CLI if missing
if ! command -v gh &>/dev/null; then
  echo "Installing GitHub CLI..."
  brew install gh
fi

# Verify auth
linear auth whoami &>/dev/null 2>&1 || { echo "ERROR: Linear not authenticated. Run: linear auth login"; exit 1; }
gh auth status &>/dev/null 2>&1 || { echo "ERROR: GitHub CLI not authenticated. Run: gh auth login"; exit 1; }
```

If any install fails, stop and tell the user what to install manually.

## Phase 1: Identify Yourself

Determine who is running this bot and set up identity for the session.

```bash
# Get Linear user identity
linear auth whoami

# Get GitHub username
gh api user --jq '.login'
```

Store both values — you'll use them for task assignment and PR reviewer.

## Phase 2: Select a Task

If `$ARGUMENTS` contains a task ID (e.g., "THU-123"):
- Fetch that specific task: `linear issue view $ARGUMENTS --json`

If `$ARGUMENTS` is empty — auto-select:
1. List eligible tasks: `linear issue list --team THU --state unstarted --sort priority`
   - Note: `linear issue list` outputs a human-readable table, NOT JSON. Parse the identifiers (e.g., "THU-303") from the table output.
2. For each candidate identifier, fetch full details: `linear issue view <identifier> --json`
3. For each candidate, run the assessment heuristic:
   ```bash
   bun run .claude/thunderbot/assess.ts '<issue-json>'
   ```
4. Pick the task with the highest score (from `scoreTask` in assess.ts)
5. If no "unstarted" tasks score well, check "backlog": `linear issue list --team THU --state backlog --sort priority`
6. If a task looks too large (complexity = "too-large"), stop and ask the human whether to break it into subtasks
7. Only ask the human if truly no task seems suitable

## Phase 3: Claim the Task

```bash
# Assign to yourself and transition to "In Progress"
linear issue update <identifier> --state "started" --assignee self
# Comment that bot is starting
linear issue comment add <identifier> --body "[Thunderbot] Starting automated work on this task."
```

## Phase 4: Create Isolated Environment

### Git Worktree

Create an isolated working copy:

```bash
# Fetch latest main
git fetch origin main

# Create worktree with branch
BRANCH="<your-linear-username>/<identifier-lowercase>-<slugified-title>"
WORKTREE_PATH=".claude/worktrees/$BRANCH"
git worktree add "$WORKTREE_PATH" -b "$BRANCH" origin/main
```

Branch naming: `<username>/thu-<number>-<slugified-title>` (lowercase, hyphens, max 60 chars).

### Docker Compose Stack

Start the isolated dev environment:

```bash
# Compute unique ports based on issue number (e.g., THU-312 → offset 312)
ISSUE_NUM=$(echo "<identifier>" | grep -o '[0-9]*')
PORT_OFFSET=$((ISSUE_NUM % 500))
AGENT_PORT_PG=$((5500 + PORT_OFFSET))
AGENT_PORT_API=$((8500 + PORT_OFFSET))
AGENT_PORT_VITE=$((5700 + PORT_OFFSET))

# Start stack
WORKTREE_PATH="$(pwd)/$WORKTREE_PATH" \
  AGENT_PORT_PG=$AGENT_PORT_PG \
  AGENT_PORT_API=$AGENT_PORT_API \
  AGENT_PORT_VITE=$AGENT_PORT_VITE \
  docker compose -f .claude/thunderbot/docker-compose.yml -p "thunderbot-$(echo <identifier> | tr '[:upper:]' '[:lower:]')" up -d --build
```

### Install Dependencies

```bash
cd "$WORKTREE_PATH"
bun install
cd backend && bun install && cd ..
```

### Run Migrations (if backend has pending migrations)

```bash
cd "$WORKTREE_PATH/backend"
DATABASE_URL="postgresql://postgres:dev@localhost:$AGENT_PORT_PG/thunderbolt" bun db push
```

**All subsequent work happens inside `$WORKTREE_PATH`.**

## Phase 5: Explore & Generate Spec

**CRITICAL: Do NOT write any code until this phase is complete.**

### Read Project Instructions

Read `AGENTS.md` and `CLAUDE.md` in the worktree. Follow them strictly for all subsequent work.

### Codebase Exploration

Launch 2-3 Explore subagents **in parallel** to understand the codebase:

- **Agent 1**: "Find all files related to [task topic]: components, routes, API endpoints, tests. Report file paths and brief descriptions."
- **Agent 2**: "Analyze existing patterns for similar features in this codebase. What patterns, utilities, and conventions should be reused? Check shared components, hooks, and types."
- **Agent 3**: "Check for shared utilities, type definitions, and test helpers that should be reused for [task topic]. Look at imports in similar files."

Wait for all agents to return before proceeding.

### Generate Spec

Based on the task description + codebase exploration results, create a spec:

```
## Spec for <identifier>: <title>

### Changes
- [ ] File: <path> — <what changes>
- [ ] File: <path> — <what changes>

### Acceptance Criteria
- [ ] <criterion from task description>
- [ ] <inferred criterion>

### Test Cases
- [ ] <test description>
- [ ] <edge case>

### Dependencies
- Reuse: <utility/component from exploration>
- Pattern: <existing pattern to follow>
```

### Post Spec to Linear

```bash
linear issue comment add <identifier> --body "$(cat <<'EOF'
---
## Generated Spec

<spec content here>

---
EOF
)"
```

Use this spec to drive all implementation. Every change should trace back to a spec item.

## Phase 6: Implement

Work through the spec systematically:

1. **Write tests first** when practical (spec lists test cases)
2. **Implement changes** — each commit should map to spec items
3. **Commit message format**: `<identifier>: <description>` (e.g., `THU-312: add login button click handler`)

### Strategic Subagent Use

- **Background test runs**: Launch a background agent to run tests while you continue implementing:
  ```
  Agent(subagent_type="general-purpose", prompt="Run 'bun test' in <worktree> and report results", run_in_background=true)
  ```
- **Parallel independent changes**: If the task has independent frontend + backend work, use parallel agents
- **Explore unfamiliar code**: When you encounter code you don't understand during implementation, launch a quick Explore agent

### Code Quality Standards

Follow the project's CLAUDE.md strictly:
- Never use `any` in TypeScript
- Prefer `type` over `interface`
- Prefer arrow functions, `const`, early returns
- Use `ky` over `fetch`, `bun` over `npm`
- Add JSDoc to new utility functions
- Test files as `<file>.test.ts` next to source

## Phase 7: Create Draft PR

After the first meaningful commit:

```bash
cd "$WORKTREE_PATH"
git push -u origin "$BRANCH"

gh pr create --draft \
  --title "<identifier>: <concise title>" \
  --body "$(cat <<'EOF'
## Summary
<2-3 bullet points of what changed>

## Linear
[<identifier>](<linear-url>)

## Test Plan
- [ ] <how to verify>
- [ ] <edge cases tested>

## Changes
<brief list of files changed and why>
EOF
)"
```

Save the PR number for later steps.

## Phase 8: Quality Checks

Run these sequentially — each may produce changes:

### 1. Tests (5x stability)
```bash
cd "$WORKTREE_PATH"
bun run test:5x
bun run test:backend:5x
```
Fix any failures. Re-run until stable.

### 2. Type Check
```bash
bun run type-check
```
Fix any errors.

### 3. Lint
```bash
bun run lint
```
Fix any issues (prefer `bun run lint:fix` then review).

### 4. Code Review — `/simplify`

Invoke the simplify skill to review your changes:
```
Skill(skill="simplify")
```
Apply suggested improvements. Re-run tests after changes.

### 5. Security Review — `/security`

If available, invoke the security skill:
```
Skill(skill="security")
```
Address real vulnerabilities. Ignore false positives that would increase complexity.

### 6. Browser Testing

If the task involves UI changes and `/chrome` skill is available:
```
Skill(skill="chrome")
```
Test against the running Docker frontend at `http://localhost:$AGENT_PORT_VITE`.

### After each quality check

If changes were made, commit them:
```bash
git add -A && git commit -m "<identifier>: <quality-step> fixes" && git push
```

## Phase 9: Finalize PR

```bash
# Get PR number
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')

# Mark as ready for review
gh pr ready "$PR_NUMBER"

# Add yourself as reviewer
GITHUB_USER=$(gh api user --jq '.login')
gh pr edit "$PR_NUMBER" --add-reviewer "$GITHUB_USER"

# Update Linear
linear issue comment add <identifier> --body "[Thunderbot] PR ready for review: $(gh pr view $PR_NUMBER --json url --jq '.url')"
linear issue update <identifier> --state "In Review"
```

## Phase 10: CI & Address Feedback

### Wait for CI
```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

### If CI fails (max 3 attempts):
1. Read the failing check logs:
   ```bash
   gh run list --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log-failed
   ```
2. Fix the issue
3. Commit, push, wait for CI again

### Check for review comments:
```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --jq '.[] | "\(.path):\(.line) \(.body)"'
```
Address real bugs/violations. Ignore style nits and false positives.

## Phase 11: Cleanup & Report

### Tear down Docker stack
```bash
docker compose -f .claude/thunderbot/docker-compose.yml -p "thunderbot-$(echo <identifier> | tr '[:upper:]' '[:lower:]')" down -v
```

### Report summary

Output a clear summary:

```
## Thunderbot Report

- **Task**: <identifier> — <title>
- **PR**: <pr-url>
- **Branch**: <branch>
- **Files changed**: <count>
- **Tests added**: <count>
- **Status**: Ready for review

### What was done
<brief description>

### Worktree
Preserved at: <worktree-path>
Clean up with: git worktree remove <worktree-path>
```

The worktree is preserved for human inspection. The human cleans it up when ready.
