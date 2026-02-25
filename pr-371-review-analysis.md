# PR #371 Review Analysis — Updated Run

_Date: 2026-02-24_

Repo: thunderbird/thunderbolt
PR: https://github.com/thunderbird/thunderbolt/pull/371
Branch: `italomenezes/prompt-separation-by-model-mode`

---

## Summary

- **63 total review threads** on PR #371
- **40 already resolved** (from previous runs + this run)
- **23 open threads analyzed** in this run
- **Authors**: `claude` (8 open), `cursor` (4 open), `cjroth` (7 open, human), `raivieiraadriano92` (4 open, human)

---

## Issues to Fix (Priority Table)

| Priority | File / Location | Issue Summary | Comment Link | Author | Type |
|----------|----------------|---------------|--------------|--------|------|
| HIGH | `src/ai/eval/runner.ts:13` | **`EVAL_timeout` typo** — env var reads `EVAL_timeout` (lowercase `t`) instead of `EVAL_TIMEOUT`. Timeout is permanently hardcoded to 120s, env var is a no-op. | [#57](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849304582) | claude | BOT |
| HIGH | `src/dal/model-profiles.ts:35` | **Upsert INSERT fails for soft-deleted profiles** — when a profile was soft-deleted, the SELECT returns null (correct), but the INSERT on line 35 hits a PK conflict since the row still exists. Unlike `createDefaultModelProfile` which uses `onConflictDoNothing`, `upsertModelProfile` does a bare INSERT that will throw. | [#56](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849304485), [#59](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849318944) | claude | BOT |
| MED | `src/ai/eval/run.ts:34` | **No try/finally for DB teardown** — if `runPool()` rejects, `teardownTestDatabase()` is never called. | [#25](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2835327821) | claude | BOT |
| MED | `src/ai/eval/runner.ts:110` | **No AbortController on timeout** — when `Promise.race` timeout wins, `aiFetchStreamingResponse` keeps running in background. | [#31](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2838799871) | claude | BOT |
| MED | `src/ai/fetch.ts:395` | **Retry escalation fires on first retry for maxAttempts=2** — `attemptNumber >= maxAttempts - 1` with values 1 >= 1 is always true, so the "final retry" escalation message fires on every retry, not just the last. Only affects GPT-OSS (maxAttempts=4) correctly; Mistral/Sonnet (maxAttempts=2) always get escalated text. | [#58](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849304694) | claude | BOT |

---

## Resolved by Bot — Auto-Closing

| Comment Link | Author | Summary | Reason for Closing |
|-------------|--------|---------|-------------------|
| [#52](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849282468) | cursor | OpenAI `systemMessageMode: 'developer'` no longer applied | **Already fixed** — commit `4e8c34b2` added hardcoded `model.vendor === 'openai'` baseline in rawOptions (line 253) |
| [#54](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849299481) | cursor | Upsert fails for soft-deleted profiles (SELECT issue) | **Already fixed** — commit `28449e24` added `isNull(deletedAt)` to the upsert SELECT (line 28) |
| [#55](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849299485) | cursor | Profile options can override OpenAI baseline | **Not a bug** — the spread order is intentional: profile overrides are the *point*. If a profile explicitly sets a different `systemMessageMode`, it should win. |
| [#60](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849319104) | claude | `resetModelProfileToDefault` un-deletes profiles | **Intentional behavior** — the function name says "reset to default," which includes restoring soft-deleted profiles. Setting `deletedAt: null` is correct. |

---

## Human Comments — Draft Responses

### Comment by @cjroth
🔗 [#34 — src/ai/prompts/vendors/mistral/search.ts](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2842677284)

**Issue reported:** "This approach feels funky. I suppose it's a valid way to prevent index pages, but really what we want the model to care about is the actual page content."

**Why it doesn't apply:** This file was deleted in the vendor-to-DB migration. The content moved to `defaultModelProfileMistralMedium31.searchModeAddendum` in the database seed. Eval scores went from 2/6 to 6/6.

**Suggested reply:**
> Totally agree the heuristic reads a bit oddly. Good news — this file is gone now. The content-verification prompt moved to the `model_profiles` database as Mistral's `searchModeAddendum`, so it's easy to iterate on without touching code. Eval scores validated the approach (2/6 → 6/6 for Mistral search), but happy to refine the wording in a follow-up.

---

### Comment by @cjroth
🔗 [#35 — src/ai/prompts/vendors/openai/models/gpt-oss-120b/config.ts](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2842680508)

**Issue reported:** "This is a really interesting idea to have model-specific tuning like this."

**Why it doesn't apply:** Positive comment. The concept evolved into the `model_profiles` DB table.

**Suggested reply:**
> Thanks! This evolved further — model-specific tuning now lives in the `model_profiles` database table. Same concept, but any model (including custom user-added ones) can get its own tuning profile. The seed data carries over the exact values we had in code.

---

### Comment by @cjroth
🔗 [#36 — src/ai/prompts/index.ts](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2842690615)

**Issue reported:** "I'm not sure if I see the use case for vendor overrides. I definitely understand model overrides - but do all of the models from the same vendor really need the same tuning?"

**Why it doesn't apply:** The vendor-level grouping was removed. Now it's one profile per model.

**Suggested reply:**
> You were right to question that! The vendor grouping was a stepping stone — it made sense with one model per vendor, but it was the wrong abstraction. The new design is exactly what you described: one profile per model in the database, no vendor grouping. Custom models can get their own profiles too.

---

### Comment by @cjroth
🔗 [#37 — .gitignore](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2842696203)

**Issue reported:** "I kind of like the idea of keeping this as a visible folder (no `.` prefix)"

**Why it doesn't apply:** Already done in commit `63bf08e0` — renamed `.evals/` to `evals/`.

**Suggested reply:**
> Done! Latest commits renamed it to `evals/` (no dot prefix). Same gitignore treatment, just visible in the file tree.

---

### Comment by @cjroth
🔗 [#38 — src/ai/prompts/vendors/mistral/chat.ts](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2842803353)

**Issue reported:** "We should use `@/types` instead of `../../types`."

**Why it doesn't apply:** All vendor files were deleted. All new code uses `@/` aliases.

**Suggested reply:**
> Good call — all vendor files were deleted in the migration, and every new import uses `@/` aliases. No more relative imports for cross-module references.

---

### Comment by @raivieiraadriano92
🔗 [#39 — src/ai/eval/scenarios.ts](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2846594050)

**Issue reported:** "maybe use lowerCase?"

**Why it doesn't apply:** Already renamed in commit `c498f7c9` — `MODELS` → `models`.

**Suggested reply:**
> Good catch! Already renamed in the latest push — all UPPER_CASE constants across the eval files are now camelCase.

---

### Comment by @raivieiraadriano92
🔗 [#40](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2846602509), [#41](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2846605401), [#42](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2846614119)

**Issue reported:** Same UPPER_CASE concern for `REVIEW_SITE_DOMAINS`, `SECTION_PATHS`, `GENERIC_SUBDOMAINS`, `BAR_WIDTH`, etc.

**Suggested reply (same for all three):**
> Yep, same fix — batch-renamed all UPPER_CASE constants to camelCase in commit `c498f7c9`. Should show up in the latest diff.

---

### Comment by @raivieiraadriano92
🔗 [#43 — src/lib/platform.ts:23](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2846720478)

**Issue reported:** "just want to confirm - these new `if` statements are necessary for the eval calls, is it right?"

**Suggested reply:**
> Yes — the eval runner runs in Bun (no browser, no `window`). The existing `typeof window === 'undefined'` check in `isTauri()` handles most cases, but the additional guard ensures we don't hit edge cases in test environments where `window` might be partially defined (e.g., jsdom). Safe defensive check at a platform boundary.

---

### Comment by @cjroth
🔗 [#61 — src/ai/fetch.ts:232](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849456926)

**Issue reported:** "These values could almost go into a typescript typed object like model config or something."

**Why it doesn't apply now:** These defaults (`defaultTemperature`, `defaultMaxSteps`, etc.) are fallbacks for when no profile exists. They're used inline with `??` (profile?.temperature ?? defaultTemperature). Extracting to a typed object is reasonable but adds indirection for 4 values used in one place.

**Suggested reply:**
> Totally fair idea. Right now they're just 4 local fallbacks for the `??` pattern — one for each profile field. If we add more, a typed defaults object makes sense. For now I'd keep them inline to avoid the indirection, but happy to extract if you feel strongly.

---

### Comment by @cjroth
🔗 [#62 — src/ai/fetch.ts:272](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849460861)

**Issue reported:** "I feel like this prepareStep logic should have unit tests if possible - lots of branches in here"

**Why it's worth noting:** Valid concern. `prepareStep` has 3 branches (citation reinforcement, final step, preventive nudge). The `isFinalStep` and `shouldShowPreventiveNudge` helpers are well-tested in `step-logic.test.ts`, but the composition inside `prepareStep` is not directly unit-tested because it's a closure inside `streamText`. Testing it would require either extracting it or integration-level testing.

**Suggested reply:**
> Agreed there are a lot of branches. The individual pieces (`isFinalStep`, `shouldShowPreventiveNudge`, `getNudgeMessagesFromProfile`) are all well-covered in `step-logic.test.ts`. The composition itself is a closure passed to `streamText`, which makes direct unit testing tricky without extracting it. I'll look into pulling the prepareStep logic into a standalone function we can test independently — good suggestion.

---

### Comment by @cjroth
🔗 [#63 — src/defaults/model-profiles.ts:1](https://github.com/thunderbird/thunderbolt/pull/371#discussion_r2849478190)

**Issue reported:** "This is going to be really hard to read and edit - and I think we'll be editing it fairly often. Would it be possible to create a similar folder structure as was there for the vendors?"

**Why it needs discussion:** This is a genuine product question. The current 150-line file has all 3 profiles inline. The previous vendor folder structure (14 files) was explicitly deleted because it was over-engineered. A middle ground could work: one file per model profile, or structured comments.

**Suggested reply:**
> Fair point about readability. The previous 14-file vendor structure was overkill, but I can see this single file getting unwieldy as we add models. How about a middle ground — one file per model (`defaults/model-profiles/gpt-oss.ts`, `defaults/model-profiles/mistral.ts`, etc.) with an `index.ts` that re-exports them all? That keeps the "one place per model" clarity without the deep vendor/model nesting. Want me to refactor it that way?

---

## Final Count

- **5 issues flagged for fixing** (HIGH: 2, MED: 3, LOW: 0)
- **4 bot threads auto-resolved** in this run (+ 32 from previous run = 36 total)
- **11 human comment draft responses** pending manual review
