You are an autonomous coding agent. Your job is to pick up a Linear task, implement it fully, and submit a PR — with minimal human intervention. Follow every phase below in order.

**Self-healing principle**: If you encounter dev environment issues (Docker, worktrees, scripts, tooling), fix the underlying problem in the relevant skill files (`.claude/commands/`), dev environment configs (`.claude/thunderbot/`), or tooling scripts — don't just work around it. Commit the fix alongside your task work so future runs don't hit the same issue.

## Phase 0: Check Prerequisites

Run `make doctor` to verify required tools. If critical tools are missing, stop and tell the user.

Additionally verify Linear and GitHub auth:

```bash
linear auth whoami
gh auth status
```

If either fails, stop and explain how to authenticate.

## Phase 1: Identify Yourself

Determine who is running this bot and set up identity for the session.

```bash
linear auth whoami
gh api user --jq '.login'
```

Store both values — you'll use them for task assignment and PR reviewer.

## Phase 2: Select a Task

If `$ARGUMENTS` contains a task ID (e.g., "THU-123"):
- Fetch that specific task: `linear issue view $ARGUMENTS --json`

If `$ARGUMENTS` is empty — auto-select:
1. List eligible tasks: `linear issue list --team THU --state unstarted --all-assignees --sort priority`
   - **Important**: Use `--all-assignees` so tasks assigned to others (e.g., labeled "Good For Bot") are not filtered out. The CLI defaults to showing only the current user's issues.
   - Note: `linear issue list` outputs a human-readable table, NOT JSON. Parse the identifiers (e.g., "THU-303") from the table output.
2. For each candidate identifier, fetch full details: `linear issue view <identifier> --json`
3. For each candidate, run the assessment heuristic:
   ```bash
   bun run .claude/thunderbot/assess.ts '<issue-json>'
   ```
4. Pick the task with the highest score (from `scoreTask` in assess.ts). Tasks labeled "Good For Bot" get a significant score boost and should typically be selected first.
5. If no "unstarted" tasks score well, check "backlog": `linear issue list --team THU --state backlog --all-assignees --sort priority`
6. If a task looks too large (complexity = "too-large"), stop and ask the human whether to break it into subtasks
7. Only ask the human if truly no task seems suitable

## Phase 3: Claim the Task

```bash
linear issue update <identifier> --state "started" --assignee self
linear issue comment add <identifier> --body "[Thunderbot] Starting automated work on this task."
```

## Phase 4: Create Isolated Environment

### Git Worktree

Create an isolated working copy:

```bash
git fetch origin main
BRANCH="<your-linear-username>/<identifier-lowercase>-<slugified-title>"
WORKTREE_PATH=".claude/worktrees/$BRANCH"
git worktree add "$WORKTREE_PATH" -b "$BRANCH" origin/main
```

Branch naming: `<username>/thu-<number>-<slugified-title>` (lowercase, hyphens, max 60 chars).

### Docker Compose Stack

Start the isolated dev environment:

```bash
ISSUE_NUM=$(echo "<identifier>" | grep -o '[0-9]*')
PORT_OFFSET=$((ISSUE_NUM % 500))
AGENT_PORT_PG=$((5500 + PORT_OFFSET))
AGENT_PORT_API=$((8500 + PORT_OFFSET))
AGENT_PORT_VITE=$((5700 + PORT_OFFSET))

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
linear issue comment add <identifier> --body "<spec content>"
```

Use this spec to drive all implementation. Every change should trace back to a spec item.

## Phase 6: Plan Implementation

**CRITICAL: Do NOT write any code until you have an approved plan.**

Enter plan mode to design the implementation approach:

```
EnterPlanMode()
```

Use the spec from Phase 5 and the codebase exploration results to create a detailed implementation plan. The plan should cover:

- Exact files to create/modify and what changes each needs
- Order of implementation steps
- Test strategy
- Any architectural decisions

Wait for the user to approve the plan before proceeding to Phase 7.

## Phase 7: Implement

Work through the approved plan systematically:

1. **Write tests first** when practical (spec lists test cases)
2. **Implement changes** — follow the approved plan step by step

### Strategic Subagent Use

- **Background test runs**: Launch a background agent to run tests while you continue implementing
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

### Committing Changes

**Always use `/thunderpush` to commit and push changes.** Never manually run `git add`, `git commit`, or `git push`. Invoke the skill:

```
Skill(skill="thunderpush")
```

This ensures atomic, conventional commits with proper formatting.

## Phase 8: Create Draft PR

After the first meaningful commit (pushed via `/thunderpush`):

```bash
cd "$WORKTREE_PATH"

gh pr create --draft \
  --title "⚡ <identifier>: <concise title>" \
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

## Phase 9: Quality Checks

Run these sequentially — each may produce changes:

### 1. Type Check + Lint + Format
```bash
make check
```
Fix any failures. If lint issues: `make lint-fix`. If format issues: `make format`.

### 2. Tests
```bash
cd "$WORKTREE_PATH"
bun test
cd backend && bun test
```
Fix any failures. Re-run until stable.

### 3. Code Review — `/simplify`

Invoke the simplify skill to review your changes:
```
Skill(skill="simplify")
```
Apply suggested improvements. Re-run tests after changes.

### After each quality check

If changes were made, use `/thunderpush` to commit and push:
```
Skill(skill="thunderpush")
```

## Phase 10: Finalize PR

```bash
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
gh pr ready "$PR_NUMBER"

GITHUB_USER=$(gh api user --jq '.login')
gh pr edit "$PR_NUMBER" --add-reviewer "$GITHUB_USER"

linear issue comment add <identifier> --body "[Thunderbot] PR ready for review: $(gh pr view $PR_NUMBER --json url --jq '.url')"
linear issue update <identifier> --state "In Review"
```

## Phase 11: CI & Address Feedback

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
3. Use `/thunderpush` to commit and push, then wait for CI again

### Check for review comments:
```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --jq '.[] | "\(.path):\(.line) \(.body)"'
```
Address real bugs/violations. Ignore style nits and false positives.

## Phase 12: Cleanup & Report

### Tear down Docker stack
```bash
docker compose -f .claude/thunderbot/docker-compose.yml -p "thunderbot-$(echo <identifier> | tr '[:upper:]' '[:lower:]')" down -v
```

### Report summary

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
