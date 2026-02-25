# Code Review Report — `italomenezes/prompt-separation-by-model-mode`

**Scope**: `main..HEAD` (18 commits, 36 files, ~3500 lines)
**Mode**: Report only — no files modified
**Reviewed by**: Opus 4.6 (orchestrator + type analysis) + Sonnet 4.6 (code review, test coverage)
**Constraint**: No prompt text changes — code implementation only

---

## Review Summary

Files reviewed: 22 source files | Findings: 14 (0 critical, 8 important, 6 suggestions)
Improvements applied: 0 (report-only mode) | Needs Human Review: 0
Verification: skipped (report-only)
Tier: Large (Haiku-triaged to Medium) | Agents used: 2 (Sonnet code reviewer, Sonnet test analyzer)

---

## Code Quality Findings

### 1. `src/dal/model-profiles.ts:25` — Upsert queries soft-deleted rows

**Severity**: important | **Confidence**: 78 | **Category**: bug

`upsertModelProfile` selects without filtering `deletedAt IS NULL`. If a profile was soft-deleted, the select finds it, takes the `if (existing)` branch, and updates the logically-deleted row instead of inserting a new one.

```typescript
// Current (line 25):
const existing = await db.select().from(modelProfilesTable)
  .where(eq(modelProfilesTable.modelId, data.modelId)).get()

// Fix — add soft-delete filter:
const existing = await db.select().from(modelProfilesTable)
  .where(and(eq(modelProfilesTable.modelId, data.modelId), isNull(modelProfilesTable.deletedAt))).get()
```

**Rule**: CLAUDE.md — "Always use soft deletes" implies filtering them out in queries.

---

### 2. `src/ai/fetch.ts:270` — Truthiness check on `number | null`

**Severity**: important | **Confidence**: 92 | **Category**: bug

`profile?.citationReinforcementEnabled && hadToolCallSteps` relies on JS falsy coercion for `number | null`. The value `0` (disabled) is falsy, `1` (enabled) is truthy, `null` is falsy — this works by coincidence. Any non-zero integer (e.g. `2`) would also be truthy.

```typescript
// Current:
profile?.citationReinforcementEnabled && hadToolCallSteps

// Fix:
profile?.citationReinforcementEnabled === 1 && hadToolCallSteps
```

---

### 3. `src/ai/eval/stream-parser.ts:40` — Unguarded JSON.parse in stream processing

**Severity**: important | **Confidence**: 80 | **Category**: error-handling

`JSON.parse(jsonStr)` inside `processLine()` has no try/catch. A malformed SSE chunk throws an exception that bubbles to the outer catch (line 79), aborting the *entire* stream. For a streaming parser, a single bad line should be skipped, not terminate all parsing.

```typescript
// Current (line 40):
const event = JSON.parse(jsonStr) as Record<string, unknown>

// Fix — wrap and skip bad lines:
let event: Record<string, unknown>
try {
  event = JSON.parse(jsonStr)
} catch {
  return // skip malformed line
}
```

---

### 4. `src/ai/eval/runner.ts:152` — Concurrency config read in two places

**Severity**: suggestion | **Confidence**: 82 | **Category**: simplification

`EVAL_SCENARIO_PARALLEL` is parsed in both `run.ts:13` and `runner.ts:152`. The value from `run.ts` is passed to `initLayout()` for spinner slots, but `runPool()` re-reads it independently.

```typescript
// runner.ts:152
const concurrency = parseInt(process.env.EVAL_SCENARIO_PARALLEL ?? '3')
```

**Fix**: Accept `concurrency` as a parameter in `runPool()` and pass `scenarioParallel` from `run.ts`.

---

### 5. `src/ai/prompt.ts:38-44` — Unnecessary inner function with parameter shadowing

**Severity**: suggestion | **Confidence**: 75 | **Category**: simplification

`getOverrideForMode` is an inner function whose parameters identically shadow the outer scope variables. It's called exactly once. Inline it or extract to module scope.

```typescript
// Current — inner function called once:
const getOverrideForMode = (modeName: string | null, profile: ModelProfile | null) => { ... }
const modeAddendum = getOverrideForMode(modeName, profile)

// Fix — inline directly:
const modeAddendum = !profile ? undefined
  : modeName === 'chat' ? profile.chatModeAddendum
  : modeName === 'search' ? profile.searchModeAddendum
  : modeName === 'research' ? profile.researchModeAddendum
  : undefined
```

**Rule**: CLAUDE.md — "Bias towards tasteful simplicity"; "Avoid over-engineering"

---

### 6. `src/lib/platform.ts:87` — `interface` instead of `type`

**Severity**: suggestion | **Confidence**: 75 | **Category**: style

```typescript
// Current:
export interface Capabilities { libsql: boolean; native_fetch: boolean }

// Fix:
export type Capabilities = { libsql: boolean; native_fetch: boolean }
```

**Rule**: CLAUDE.md — "Prefer `type` over `interface`"

---

## Test Coverage Findings

### 7. `src/ai/step-logic.ts:93-119` — Profile-override branches untested

**Severity**: important | **Confidence**: 95 | **Category**: test-coverage

`getNudgeMessagesFromProfile` only has tests for null-profile paths. The non-null branches (partial `??` fallback, search vs non-search dispatch with profile overrides) are the most regression-prone paths and have **zero** coverage.

**Fix**: Add 6 tests to `step-logic.test.ts` covering profile with all nudge fields, partial fields with fallback, and no override fields — for both search and non-search modes.

---

### 8. `src/ai/eval/scoring.ts` — No test file for 6 pure functions

**Severity**: important | **Confidence**: 95 | **Category**: test-coverage

`extractCitations`, `isHomepage`, `isReviewSite`, `extractLinkPreviewUrls`, `extractWidgets`, `scoreResult` are deterministic, well-defined, and have subtle edge cases (fullwidth brackets, specific-subdomain exceptions, section-path matching).

**Fix**: Create `src/ai/eval/scoring.test.ts`.

---

### 9. `src/ai/prompt.ts` — No test file for createPrompt

**Severity**: important | **Confidence**: 90 | **Category**: test-coverage

Profile-driven override logic (toolsOverride, linkPreviewsOverride, mode addenda) is untested. Each modeName branch and null/non-null profile path should be covered.

**Fix**: Create `src/ai/prompt.test.ts`.

---

### 10. `src/ai/eval/stream-parser.ts` — No test file for SSE parser

**Severity**: important | **Confidence**: 90 | **Category**: test-coverage

Buffer splitting, event type dispatch, retry heuristic, and error recovery are all non-obvious logic with no coverage.

**Fix**: Create `src/ai/eval/stream-parser.test.ts`.

---

### 11. `src/dal/models.ts:147-177` — Cascade and auto-profile untested

**Severity**: important | **Confidence**: 92 | **Category**: test-coverage

`createModel` calls `createDefaultModelProfile` (line 176) but no test verifies the profile row exists after creation. `deleteModel` calls `deleteModelProfileForModel` (line 153) but no test verifies the profile is soft-deleted on model deletion.

**Fix**: Add 2 tests to `models.test.ts`.

---

### 12. `src/ai/eval/report.ts` — No test file for summarize

**Severity**: important | **Confidence**: 88 | **Category**: test-coverage

`summarize` is a pure aggregation function with rounding and group-by logic. Division-by-zero edge case for empty results.

**Fix**: Create `src/ai/eval/report.test.ts` (covering `summarize` at minimum).

---

### 13. `src/defaults/model-profiles.ts` — hashModelProfile untested

**Severity**: suggestion | **Confidence**: 80 | **Category**: test-coverage

The hash determines whether user edits are preserved or overwritten on app start. If a field is accidentally omitted, user modifications would be silently lost.

**Fix**: Create `src/defaults/model-profiles.test.ts` covering determinism, single-field sensitivity, and modelId exclusion.

---

### 14. `src/ai/eval/ui.ts` — silenceConsole/restoreConsole untested

**Severity**: suggestion | **Confidence**: 70 | **Category**: test-coverage

These two functions are self-contained and testable without mocking. The rest of `ui.ts` is terminal I/O (skip).

**Fix**: Create `src/ai/eval/ui.test.ts` covering only these two functions.

---

## Not Flagged (reviewed and clean)

- `src/db/tables.ts` — Schema correct, FK + index properly configured
- `src/db/relations.ts` — Bidirectional relation follows existing pattern
- `src/types.ts` — ModelProfileRow/ModelProfile consistent with project conventions
- `src/dal/model-profiles.test.ts` — 12 thorough tests with good edge cases
- `src/dal/models.ts` — Lazy imports match existing `deleteModel` pattern
- `src/dal/index.ts` — Re-export follows convention
- `src/lib/reconcile-defaults.ts` — Correctly uses `'modelId'` key field
- `src/defaults/modes.ts` — Mode prompt imports clean
- `src/ai/prompts/modes/` — Prompt text files (not code — out of scope)
- `src/chats/chat-instance.ts` — 1-line import addition
- `src/ai/eval/types.ts` — Clean type definitions
- `src/ai/eval/scenarios.ts` — Scenario data (not logic)
- `src/ai/eval/debug-single.ts` — Simple entry point
- `src/ai/eval/run.ts` — Clean orchestration (except #4 above)
- No privacy/PII concerns found across any files
- No security vulnerabilities found

---

## Agent Execution Summary

| Agent | Model | Findings | Notes |
|-------|-------|----------|-------|
| Enhanced Code Reviewer | Sonnet 4.6 | 3 | Caught upsert soft-delete bug, concurrency duplication, inner function shadowing |
| PR Test Analyzer | Sonnet 4.6 | 8 | Comprehensive coverage gap analysis across 9 source files |
| Orchestrator (Phase 2) | Opus 4.6 | 3 | Added fetch.ts truthiness, platform.ts interface, stream-parser JSON.parse |
