# Subagent Playbook

Decision framework, coordination rules, and prompt templates for orchestrating subagents. This is the single source of truth for when and how to parallelize work in ThunderBot.

## Contents

1. Decision Framework — when to parallelize, sequence, or background
2. Concurrency Limits — max 10, no nesting, batch behavior
3. Context Passing Rules — what to include in every subagent prompt
4. Model Routing — Opus / Sonnet / Haiku selection guide
5. Domain-Based File Routing — preventing file conflicts between agents
6. Prompt Templates — Explore, Implement, Review, Test, CI-Fix, Quality Check
7. Result Collection — deduplication, disagreement resolution, synthesis
8. Anti-Patterns — over-parallelizing, vague prompts, duplicate ownership
9. Background Patterns — test runner, CI monitor, diff analyzer

---

## Decision Framework

### When to Parallelize

Use parallel subagents when:
- **3+ unrelated tasks** can proceed independently
- Tasks have **no shared state** or files
- Each task has **clear file boundaries** (no two agents touch the same file)
- Combined sequential time would exceed 60 seconds

### When to Sequence

Use sequential execution when:
- Task B depends on the output of Task A
- Two tasks modify the same files
- Order matters (e.g., schema migration before API implementation)
- The combined work is small enough that parallelization overhead is not worth it

### When to Background

Use `run_in_background: true` when:
- A task takes >30 seconds (test suites, CI monitoring, large diffs)
- The result does not block your next action
- You want to continue working while it runs

You will be notified when background tasks complete. Do not poll or sleep.

---

## Concurrency Limits

- **Maximum 10 concurrent subagents** per dispatch
- Claude waits for the **entire batch** before starting the next batch
- Subagents **cannot spawn other subagents** -- this is a hard constraint of the runtime
- A subagent's only output is its final message -- intermediate tool calls stay inside the subagent

---

## Context Passing Rules

The **only channel** from parent to subagent is the prompt string. There is no shared memory, no environment variables, no file watchers.

### What to Include in Every Subagent Prompt

1. **File paths**: Exact paths to read, modify, or create
2. **Error messages**: Full text of any errors being investigated
3. **Decisions made**: Architectural choices the agent must follow
4. **Success criteria**: How to know the task is done
5. **Boundary constraints**: Which files the agent may NOT touch

### What Stays Inside the Subagent

- All intermediate tool calls (Read, Edit, Bash, Grep)
- Reasoning and exploration steps
- Only the final message returns to the parent

---

## Model Routing

| Model | Use For | Cost |
|-------|---------|------|
| **Opus** | Deep reasoning: architecture, security analysis, threat modeling, complex planning, type design review | Highest |
| **Sonnet** | Implementation: code writing, code review, testing, most day-to-day coding tasks | Medium |
| **Haiku** | Classification: file triage, I/O signals, simple categorization tasks | Lowest |

### Routing Heuristic

- If the task requires **judgment about trade-offs**: Opus
- If the task requires **writing or reviewing code**: Sonnet
- If the task requires **sorting, classifying, or simple I/O**: Haiku

---

## Domain-Based File Routing

Subagents must NOT touch the same files. Split work by domain:

| Domain | Files | Agent Type |
|--------|-------|------------|
| Frontend | `src/` (excluding `src/api/`, `src/types/`) | Frontend agent |
| Backend | `backend/` | Backend agent |
| Shared types | `src/types/`, `shared/` | Types agent (or handled by one domain agent) |
| Tests | `*.test.ts` next to their source | Same agent as source file |
| Config | `*.config.*`, `Makefile`, `docker-compose.*` | Infrastructure agent |

If two domains share a boundary file (e.g., API types used by both frontend and backend), assign ownership to one agent and have the other read it as input.

---

## Prompt Templates

### 1. Explore Subagent

```
Find all files related to [TOPIC] in this codebase.
Search in: [DIRECTORIES_TO_SEARCH]

For each file found, report:
- Full file path
- One-line description of its role
- Key exports (functions, types, components)

Do not modify any files.
```

### 2. Implement Subagent

```
Implement [SPECIFIC_CHANGE] in [SPECIFIC_FILES].

Context:
- This is part of [TASK_IDENTIFIER]: [TASK_DESCRIPTION]
- Architecture decision: [RELEVANT_DECISION]
- Pattern to follow: [REFERENCE_FILE] uses [PATTERN]

Rules:
- Follow CLAUDE.md conventions (TypeScript: no `any`, prefer `type`, arrow functions, `const`)
- Do NOT modify any files outside: [EXPLICIT_FILE_LIST]
- Add JSDoc to new utility functions
- Create test file as <file>.test.ts if adding new exports

Success criteria:
- [CRITERION_1]
- [CRITERION_2]
```

### 3. Review Subagent

Use the templates from `references/review.md`:
- Enhanced Code Reviewer (sonnet)
- Type Design Analyzer (opus)
- PR Test Analyzer (sonnet)
- Diff Triage (haiku)

### 4. Test Subagent

```
Run the test suite and report results.

Commands to run:
1. cd [PROJECT_ROOT] && bun test
2. cd [PROJECT_ROOT]/backend && bun test

Report:
- Total tests: pass/fail/skip counts
- For each failure:
  - Test name and file path
  - Expected vs actual output
  - Root cause (which source file is responsible)
- Overall status: PASS or FAIL

Do not modify any files.
```

### 5. CI-Fix Subagent

```
Read the CI logs below and identify the root cause of the failure.

<ci-logs>
[CI_LOG_OUTPUT]
</ci-logs>

Report:
1. Which CI step failed
2. The exact error message
3. The file and line number causing the failure
4. A specific, actionable fix recommendation
5. Whether this is a test failure, build failure, lint failure, or infrastructure issue

Do not modify any files.
```

### 6. Quality Check Subagent

```
Run quality checks on the codebase.

Commands:
1. make check (type checking, linting, formatting)
2. bun test (root)
3. cd backend && bun test (backend)

For each failure, report:
- Command that failed
- File and line number
- Error message
- Suggested fix

Do not modify any files.
```

---

## Result Collection

After dispatching a batch of subagents:

1. **Wait for all agents** in the batch to complete
2. **Collect all results** before making decisions
3. **Deduplicate findings**: If two agents flag the same file+line, keep the higher-confidence finding and note agreement
4. **Resolve disagreements**: If agents disagree, prefer the finding with higher confidence. If confidence is equal, prefer the agent with domain expertise (e.g., Type Design Analyzer for type issues)
5. **Synthesize**: Combine findings into a unified action plan before proceeding

---

## Anti-Patterns

### Do Not Over-Parallelize

- **Bad**: Launching 10 agents for 3 files
- **Good**: One agent per independent domain (frontend, backend, tests)

### Do Not Send Vague Prompts

- **Bad**: "Implement the feature"
- **Good**: "Implement the NotificationToggle component in src/components/NotificationToggle.tsx. Follow the pattern in src/components/SettingsToggle.tsx."

### Do Not Duplicate File Ownership

- **Bad**: Agent 1 modifies `src/types/user.ts`, Agent 2 also modifies `src/types/user.ts`
- **Good**: Agent 1 owns `src/types/user.ts`, Agent 2 reads it as input

### Do Not Launch Agents for Trivial Tasks

- **Bad**: Spawning a subagent to rename a variable
- **Good**: Rename the variable directly, reserve agents for substantial work

### Do Not Forget Boundary Constraints

- **Bad**: "Implement the backend changes" (which files?)
- **Good**: "Implement changes in backend/src/routes/notifications.ts and backend/src/services/notifications.ts. Do not modify files outside backend/src/."

---

## Background Patterns

For tasks that take >30 seconds and do not block the next action:

```
[Task: Test Runner]
model: "sonnet"
run_in_background: true
prompt: "Run `bun test` and report results. Do not modify any files."
```

```
[Task: CI Monitor]
model: "sonnet"
run_in_background: true
prompt: "Run `gh pr checks $PR_NUMBER --watch --fail-fast` and report the final status."
```

```
[Task: Diff Analyzer]
model: "sonnet"
run_in_background: true
prompt: "Analyze the diff from `git diff main...HEAD`. Summarize changes by domain
(frontend, backend, shared, tests, config). Report file counts and line counts per domain."
```

Continue work in the main thread. You will be notified when each background task completes.
