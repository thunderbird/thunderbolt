# Implementation Reference

Standards and patterns for exploring, planning, implementing, and validating code changes in the Thunderbolt codebase. Used during ThunderBot's autonomous workflow (Phases 5-7) and when running `/thunderbot` in `implement` mode.

## Contents

1. Codebase Exploration Protocol — parallel subagent prompts for understanding the codebase
2. Spec Generation — template for creating implementation specs
3. Implementation Planning — plan structure for autonomous execution
4. Testing-First Workflow — write tests before code, background test runners
5. Code Quality Standards — CLAUDE.md conventions, security-first principle
6. Subagent Patterns for Implementation — background tests, parallel changes, quick explore
7. Quality Gate Before Push — mandatory sequence before every push
8. Soft Delete Convention — frontend vs backend deletion rules

---

## Codebase Exploration Protocol

Before writing any code, launch 2-3 Explore subagents **in parallel** to build a mental model of the relevant codebase. Wait for all agents to return before proceeding.

### Subagent Prompts

**Agent 1 — File Discovery:**

```
Find all files related to [TOPIC] in this codebase. Search for:
- Components, routes, and pages that render or manage [TOPIC]
- API endpoints and backend handlers for [TOPIC]
- Database schema definitions (Drizzle tables, PowerSync schemas)
- Existing test files for the above

Report each file path with a one-line description of its role.
Do not modify any files.
```

**Agent 2 — Pattern Analysis:**

```
Analyze existing patterns in this codebase for features similar to [TOPIC]. Look at:
- How similar features are structured (component → hook → API → DB)
- Shared components, hooks, and utility functions that get reused
- Naming conventions and directory structure
- State management patterns (useReducer vs useState, DAL patterns)
- Error handling patterns (optimistic vs defensive, where errors surface)

Report the patterns you find with file path examples for each.
Do not modify any files.
```

**Agent 3 — Utilities & Types:**

```
Find shared utilities, type definitions, and test helpers relevant to [TOPIC]:
- Type definitions in shared/ or types/ directories
- Utility functions that similar features import
- Test helpers, fixtures, and mock patterns
- Constants, enums, and configuration values

Check imports in files identified by other agents for additional shared dependencies.
Report file paths and the specific exports that should be reused.
Do not modify any files.
```

### When to Use Fewer Agents

- **Trivial tasks** (rename, typo fix): Skip exploration entirely.
- **Small tasks** (single file, clear scope): One agent for file discovery is sufficient.
- **Medium+ tasks**: Always use 2-3 agents. The upfront cost prevents costly mid-implementation pivots.

---

## Spec Generation

After exploration completes, synthesize a spec from the task description and exploration results. The spec drives all implementation decisions.

### Spec Template

```markdown
## Spec for <IDENTIFIER>: <TITLE>

### Changes
- [ ] File: <path> -- <what changes and why>
- [ ] File: <path> -- <new file: purpose>

### Acceptance Criteria
- [ ] <criterion from the Linear task description>
- [ ] <inferred criterion from exploration>
- [ ] <edge case criterion>

### Test Cases
- [ ] <happy path test>
- [ ] <edge case test>
- [ ] <error/boundary test>

### Dependencies
- Reuse: <utility/component discovered during exploration>
- Pattern: <existing pattern to follow, with file reference>

### Risks
- <anything that could go wrong or needs clarification>
```

### Post to Linear

```bash
linear issue comment add <IDENTIFIER> --body "<spec content>"
```

Every implementation change must trace back to a spec item.

---

## Implementation Planning

Write a detailed plan before touching code. The plan is the contract for autonomous execution.

### Plan Structure

1. **Files to create** -- path, purpose, key exports
2. **Files to modify** -- path, what changes, which functions affected
3. **Order of implementation** -- sequence that enables incremental testing
4. **Test strategy** -- which tests to write first, what they cover
5. **Architectural decisions** -- choices made and why (reference exploration findings)
6. **Subagent strategy** -- which parts can be parallelized (see subagent-playbook.md)

### Autonomous Execution

ThunderBot proceeds without user approval once the plan is written. The plan itself is the approval gate -- write it carefully.

---

## Testing-First Workflow

Write tests before implementation when practical:

1. **Create test file** next to the source file: `<file>.test.ts`
2. **Write failing tests** for the acceptance criteria
3. **Implement** until tests pass
4. **Add edge case tests** discovered during implementation

### Background Test Subagent

While continuing implementation, launch a background test runner:

```
Run `bun test` in the project root and `bun test` in backend/.
Report results. If failures, identify the root cause and report the failing test name,
expected vs actual output, and the source file responsible.
Do not modify any files.
```

Use `run_in_background: true` so the main thread continues working. You will be notified when tests complete.

---

## Code Quality Standards

Follow CLAUDE.md strictly. Key rules for quick reference:

- Never use `any` in TypeScript
- Prefer `type` over `interface`
- Prefer arrow functions over `function` keyword
- Prefer `const` over `let` -- use helper functions with early return
- Use `ky` over `fetch`, `bun` over `npm`
- Add JSDoc comments to new utility functions
- Only comment non-obvious code
- One React component per file (loosely)
- `useReducer` when 3+ `useState` hooks
- Abstract state/logic into `use[Component]State()` hooks
- Test files as `<file>.test.ts` next to source

### Security-First Principle

Every change must be reviewed through a security lens:

- **Inputs**: Is user input validated and sanitized before use?
- **Outputs**: Could sensitive data leak into logs, URLs, or error messages?
- **Auth**: Are authorization checks in place for new endpoints or actions?
- **Dependencies**: Are new packages from trusted sources? Any known vulnerabilities?
- **Secrets**: Are API keys, tokens, or credentials hardcoded anywhere?

This is not a separate step -- it is part of writing every line of code.

---

## Subagent Patterns for Implementation

See `references/subagent-playbook.md` for the full orchestration guide. Quick reference for implementation:

### Background Test Runs

Launch test runner in background while continuing to write code:

```
model: "sonnet"
run_in_background: true
prompt: "Run `bun test` and `cd backend && bun test`. Report pass/fail counts and any failure details."
```

### Parallel Independent Changes

When frontend and backend changes are independent (no shared files):

```
[Agent 1 - Frontend] model: "sonnet"
prompt: "Implement [frontend change] in [specific files]. Follow CLAUDE.md. Do not modify backend/ files."

[Agent 2 - Backend] model: "sonnet"
prompt: "Implement [backend change] in [specific files]. Follow CLAUDE.md. Do not modify files outside backend/."
```

### Quick Explore During Implementation

When you encounter unfamiliar code mid-implementation:

```
model: "sonnet"
prompt: "Read [file path] and explain how [specific function/pattern] works.
What are its inputs, outputs, and side effects? How do callers use it?"
```

### Quality Check Subagent

Run `make check` in background while writing more code:

```
model: "sonnet"
run_in_background: true
prompt: "Run `make check` in the project root. Report any TypeScript errors, lint failures,
or format issues. For each failure, report the file, line, and error message."
```

---

## Quality Gate Before Push

Always run this sequence before pushing. Each step must pass before the next:

1. **`make check`** -- Type checking, linting, formatting. Fix failures: `make lint-fix`, `make format`.
2. **`bun test`** -- Run tests in root and `backend/`. Fix any failures.
3. **`/thunderimprove`** -- Review changes for quality, security, and maintainability. Apply fixes, then re-run steps 1-2 if changes were made.
4. **`/thunderpush`** -- Atomic, conventional commit via the push skill.
5. **`/thunderfix`** -- Monitor CI and address any PR feedback.

Never skip steps. Never manually run `git add`, `git commit`, or `git push`.

---

## Soft Delete Convention

Per CLAUDE.md:

- **Frontend**: Never hard delete. Set `deletedAt` via API calls that update, not remove.
- **Backend**: Prefer soft deletes. Hard delete only for account deletion, PowerSync operations, or other cases where permanent removal is by design.

When implementing delete functionality, always default to soft delete unless the task explicitly requires hard deletion.
