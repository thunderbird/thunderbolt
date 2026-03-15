---
context: fork
description: "Review changed code for quality, security, and maintainability. Supports tiered analysis by diff size, confidence scoring, and optional auto-fix."
---

Review changed code for quality, security, and maintainability. Finds issues AND fixes them (when approved) while preserving exact functionality.

## Scope Rules

<scope-constraints>
- ONLY review code changed on the current branch vs its base (main/master) -- never flag pre-existing issues
- ONLY edit files that appear in the branch diff -- never touch unrelated files
- ONLY enforce rules from CLAUDE.md, not personal style preferences
- Respect the chosen REVIEW_MODE -- in "report-only" mode, NEVER modify any file
- Respect lint-ignore comments as intentional decisions
- Skip issues CI/linters will catch (TypeScript errors, formatting)
- Privacy/PII findings are NEVER discarded regardless of confidence score
- NEVER invent findings to fill a report -- if code is clean, say so
- Be direct -- this is self-review, not PR feedback. Fix problems, explain why.
</scope-constraints>

---

## Mode Selection

Ask the user:

> **Choose review mode:**
> 1. **Report only** -- full analysis, zero file changes
> 2. **Auto-fix** -- apply high-confidence fixes (>=90), ask before judgment calls (70-89)

Store the chosen mode as `REVIEW_MODE` (`report-only` or `auto-fix`).

- `report-only`: Skip Phase 3 and Phase 4. Produce the report with findings and recommendations, but modify nothing.
- `auto-fix`: Run the full pipeline including confirmation gate and fix application.

---

## Phase 0: Gather Context

### 0.1 Detect base branch and collect the diff

**Find the base branch:**
1. Run `git branch --list main master`
2. If `main` exists, `BASE_BRANCH=main`. Else if `master` exists, use it.
3. Else ask the user.

**Find the merge base:**
```bash
MERGE_BASE=$(git merge-base HEAD $BASE_BRANCH)
```

**Collect three layers of changes:**
1. Committed on this branch: `git diff $MERGE_BASE..HEAD`
2. Staged but not committed: `git diff --cached`
3. Unstaged working changes: `git diff`

Combine all three into the review scope. Run `git status` in parallel to get the file list.

### 0.2 Classify diff size

Count changed files:
- **Small** (1-3 files, <100 lines): Tier A -- single orchestrator pass
- **Medium** (4-15 files): Tier B -- parallel subagents
- **Large** (16+ files): Tier C -- Haiku triage first, then subagents

### 0.3 Read project configuration

Read `CLAUDE.md` at the project root. If not found, warn and continue with general best practices. Do not fabricate rules.

### 0.4 Auto-detect toolchain

| Signal | Type Check Command | Test Command |
|--------|-------------------|-------------|
| `bun.lockb` or `bunfig.toml` | `bun tsc --noEmit` | `bun test` |
| `package-lock.json` | `npx tsc --noEmit` | `npm test` |
| `yarn.lock` | `yarn tsc --noEmit` | `yarn test` |
| `Cargo.toml` | `cargo check` | `cargo test` |
| `go.mod` | `go vet ./...` | `go test ./...` |
| None detected | Skip | Skip |

Store as `TYPE_CHECK_CMD` and `TEST_CMD`.

### 0.5 Detect privacy priority

Scan CLAUDE.md for "privacy", "PII", "GDPR", "HIPAA", "sensitive data":
- Found: `PRIVACY_PRIORITY = true` (privacy findings elevated to critical severity)
- Not found: `PRIVACY_PRIORITY = false` (privacy checks still run at normal severity)

---

## Phase 1: Tiered Analysis

### Tier A: Small Diffs (1-3 files)

Skip subagent spawning. You (the orchestrator) perform a single-pass review covering all 10 dimensions from Phase 2. This is faster and often higher quality for small changes -- full context without summarization loss.

### Tier B: Medium Diffs (4-15 files)

**Read `.thunderbot/references/review.md`** for subagent prompt templates.

Launch applicable agents in parallel via the Task tool:

1. **Enhanced Code Reviewer** (model: sonnet) -- always dispatched. Covers CLAUDE.md compliance, bugs, silent failures, simplification, privacy.
2. **Type Design Analyzer** (model: opus) -- only if type/interface/enum definitions were added or modified.
3. **PR Test Analyzer** (model: sonnet) -- only if non-test source files changed.

Provide each agent with the diff, CLAUDE.md content, and changed file list per the templates in review.md.

### Tier C: Large Diffs (16+ files)

**Read `.thunderbot/references/review.md`** for subagent prompt templates.

**Step 1:** Launch Haiku triage to classify all changed files as `needs-review`, `types-only`, `tests-only`, or `trivial`.

**Step 2:** Route to Tier B agents based on classification:
- `needs-review` files -> Enhanced Code Reviewer
- `types-only` files -> Type Design Analyzer
- `tests-only` files -> PR Test Analyzer (for completeness)
- `trivial` files -> skip agent review (spot-check in Phase 2)

---

## Phase 2: Review Dimensions

After subagents complete (or instead of agents for Tier A), review the diff through these 10 lenses. This catches nuanced issues that automated analysis misses.

### 1. Root Cause vs Bandaid
Does this fix the actual root cause? Or does it paper over the symptom? A bandaid is acceptable only if explicitly acknowledged.

### 2. Correctness
Is this the best, most correct solution? Simpler alternatives? Could this introduce subtle bugs (off-by-one, race conditions, null references)?

### 3. Robustness & Edge Cases
Is this code fragile? Will it break if inputs change slightly? Does it handle edge cases that are likely to occur in practice?

### 4. Impact
Could this change break callers or consumers? Check for implicit dependencies that might be affected.

### 5. Reuse & DRY
Is there existing code that does the same thing? Check shared utilities, hooks, and components. Could new logic be extracted into a reusable utility?

### 6. Test Coverage
Missing test cases for changed code? Edge cases tested? Regression tests for bug fixes?

### 7. Privacy & PII
Think step by step about data flows:
- Does any changed line log, store, or transmit user data?
- Is PII (email, IP, name, location, device ID, session token) exposed in logs, URLs, or error messages?
- Is there unintended telemetry or third-party data sharing?
- Would a privacy-conscious user be comfortable with this?

If `PRIVACY_PRIORITY = true`: all privacy findings are automatically critical severity.

### 8. Security
Use the STRIDE framework for systematic analysis:
- **Spoofing**: Can an attacker impersonate a user or service?
- **Tampering**: Can data be modified in transit or at rest?
- **Repudiation**: Can actions be traced and audited?
- **Information Disclosure**: Where could sensitive data leak?
- **Denial of Service**: What resources could be exhausted?
- **Elevation of Privilege**: How could permissions be bypassed?

Also check for: XSS via unsanitized input, SQL/NoSQL injection, auth/authz bypass, CSRF, path traversal, open redirects, hardcoded secrets, insecure crypto.

### 9. Simplification
Unnecessary complexity? Redundant abstractions? Verbose patterns that have cleaner alternatives?

### 10. Resource Management
Services instantiated repeatedly? Missing cleanup for listeners or connections? Wrong initialization order?

---

## Confidence Scoring

Score every finding 0-100:

| Score | Meaning | Action |
|-------|---------|--------|
| 90-100 | Definitely real (bug, security flaw, PII exposure) | Auto-fix if unambiguous mechanical change |
| 70-89 | Likely real and worth addressing | Present for user approval before fixing |
| 50-69 | Possibly real | Show as "Needs Human Review" -- never auto-fix |
| Below 50 | Uncertain | Discard silently |

**Privacy override**: Privacy/PII findings are NEVER discarded regardless of score. Even a confidence-30 privacy concern must appear in the report.

**No findings escape hatch**: Zero findings is valid and expected. Report "No issues found" with a brief summary of what was checked. Do not lower the threshold to produce findings.

---

## Result Aggregation

Merge your findings (Phase 2) with subagent findings (Phase 1):

1. **Deduplicate**: If you and an agent flag the same file+line range, keep the higher-confidence finding and note agreement.
2. **Apply confidence scoring** to all findings (yours and agents').
3. **Sort by severity**: critical first, then important, then suggestions.

---

## Phase 3: Confirmation Gate

**If `REVIEW_MODE = report-only`: Skip to Phase 5.**

Present a summary before applying any fixes:

```
## Analysis Complete

Files reviewed: N | Findings: N (N critical, N important, N suggestions, N needs-review)

### Will Auto-Fix (confidence >= 90, unambiguous):
1. [file:line] Description

### Requires Your Approval (confidence 70-89):
1. [file:line] Description -- [approve/skip]

### Needs Human Review (confidence 50-69):
1. [file:line] Description -- uncertain, your judgment needed

### Privacy Concerns (any confidence):
1. [file:line] Description

Proceed with auto-fixes? [Y/n]
```

Wait for user confirmation. If declined, report findings only without modifications.

If more than 15 auto-fixes are queued, warn: "Large number of auto-fixes (N). Review the list above carefully before approving."

---

## Phase 4: Fix and Verify

**If `REVIEW_MODE = report-only`: Skip to Phase 5.**

### Apply fixes

Use the Edit tool for approved fixes. Apply in **reverse line order** (highest line numbers first) to avoid line-number drift.

If an Edit fails: log the failure, skip that fix, continue with remaining fixes, report in summary.

### Auto-fixable patterns (TypeScript, per CLAUDE.md)

- `interface` -> `type`
- `function` keyword -> arrow function
- `let` -> `const` (when value is never reassigned)
- Nested conditionals -> early return
- `.then/.catch` -> `async/await`
- `React.useEffect` -> direct `useEffect` import
- Unused imports (when clearly unused in diff context)

### Verify

Run the auto-detected commands from Phase 0:
1. Type check: `{TYPE_CHECK_CMD}`
2. Tests: `{TEST_CMD}`

If verification fails after fixes:
1. Report the specific error
2. Offer: "Verification failed. Revert all changes? [Y/n]"
3. If confirmed: `git checkout -- {list of modified files}`

If no type check or test command was detected, skip verification and note it in the report.

---

## Phase 5: Report

```
## Review Summary

Files reviewed: N | Issues found: N (N critical, N important, N suggestions)
Improvements applied: N | Skipped: N | Needs Human Review: N
Verification: passed / failed / skipped
Tier: small / medium / large | Agents used: N (list with models)
```

### Applied Fixes
For each: `file:line` -- what changed (brief before/after) -- rule or principle applied.

### Issues Requiring Approval
For each: `file:line` -- severity -- confidence -- description -- recommendation.

### Needs Human Review (confidence 50-69)
For each: `file:line` -- description -- why confidence is uncertain.

### Privacy Concerns
For each (regardless of confidence): `file:line` -- concern -- recommendation.

### Agent Execution Summary (medium/large diffs)
Which agents ran, model used, finding count, or "skipped (not applicable)."

---

## Scope Rules (Reminder)

<scope-constraints>
- ONLY review code changed on the current branch vs its base
- ONLY edit files in the branch diff -- and ONLY in auto-fix mode
- In report-only mode: NEVER modify any file
- ONLY enforce CLAUDE.md rules, not personal preferences
- Respect lint-ignore comments
- Skip issues CI/linters catch
- Privacy/PII findings are NEVER discarded
- NEVER invent findings
</scope-constraints>
