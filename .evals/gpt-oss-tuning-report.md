# GPT-OSS Tuning Report

> February 20, 2026 — Summary of changes that took GPT-OSS from 84% to 98% pass rate (100% on validation set)

## The Problem

GPT-OSS (self-hosted, OpenAI-compatible via vLLM) had three recurring issues:

1. **Blank responses** — The model made tool calls, gathered data, then produced empty text output
2. **Under-citation** — Research mode produced 5000-8000 char reports with only 2-4 `[N]` citations instead of the required 5+
3. **Nudge trap** — Injected "respond now" messages caused the model to acknowledge the nudge instead of synthesizing tool results

## Root Causes Found

### 1. Preventive nudge bombardment

`shouldShowPreventiveNudge` counts tool-call steps **cumulatively**. Once the threshold was crossed (set to 3), every subsequent step got a user-role "Synthesize your tool results and respond now" injected. GPT-OSS interpreted these as user questions and fell into an acknowledgment loop.

**Fix**: Raised `nudgeThreshold` from 3 to 5, and created softer GPT-OSS-specific nudge messages that tell the model **what to write** rather than just demanding a response.

### 2. Retry logic gave up too early

When attempt 1 made tool calls and produced empty text, the retry fired correctly. But on retry attempt 2, the model responded with empty text and **no** tool calls (because the nudge said "no more tools"). The `hasToolCalls(response.messages)` check only looked at the current attempt, returned `false`, and gave up — despite having gathered data in attempt 1.

**Fix**: Added `anyAttemptHadToolCalls` flag that persists across all retry attempts. If any attempt ever made tool calls, subsequent retries continue up to `maxAttempts`.

### 3. Too many steps before forced synthesis

With `maxSteps=12`, the model had 11 steps to call tools before the final step nudge (with tools disabled) fired. Many blank responses came from scenarios where the model used 4-7 steps and stopped early with empty text — the final step nudge never had a chance to fire.

**Fix**: Lowered `maxSteps` from 12 to 8. The final step nudge now fires at step 7, forcing synthesis much sooner. Combined with 4 retry attempts, the model gets plenty of chances to produce text.

### 4. Homepage detection false positives

The `isHomepage` function flagged all bare-root URLs (`/`) as homepages. Subdomain-based apps like `server-components.epicreact.dev/` were incorrectly flagged even though the subdomain itself IS the content.

**Fix**: Added subdomain awareness — specific subdomains (not `www`, `m`, `app`, etc.) at a bare root are treated as content pages, not homepages.

## Configuration Changes

### `src/ai/prompts/vendors/openai/config.ts`

| Parameter | Before | After | Reason |
|---|---|---|---|
| `temperature` | 0.4 | 0.3 | Slightly more deterministic, reduces empty response variance |
| `maxSteps` | 12 | 8 | Forces earlier synthesis, prevents runaway tool loops |
| `maxAttempts` | 2 → 3 | 4 | More recovery chances for transient blanks |
| `nudgeThreshold` | 3 → Infinity | 5 | One gentle mid-point nudge instead of bombardment or nothing |

### `src/ai/prompts/vendors/openai/` — New prompt override files

| File | Purpose |
|---|---|
| `global.ts` | "After calling tools, you MUST write a text response" — catches silent stops |
| `chat.ts` | Reinforces citation requirements ("aim for at least 2 citations") |
| `research.ts` | Enforces citation discipline ("count your [N] citations before finishing") |
| `nudges.ts` | Softer language that avoids the acknowledgment trap |

### `src/ai/fetch.ts` — Retry fix

```typescript
// Before: checked only current attempt
const hadToolCalls = hasToolCalls(response.messages)

// After: tracks across ALL attempts
anyAttemptHadToolCalls = anyAttemptHadToolCalls || hadToolCalls
if (shouldRetry(totalText, anyAttemptHadToolCalls, attemptNumber, maxAttempts)) { ... }
```

## Results

### Progress across iterations

| Iteration | Overall | Chat | Search | Research | Key change |
|---|---|---|---|---|---|
| Baseline | 84% | 67% | 93% | 93% | — |
| + softer nudges | 84% | 67% | 93% | 93% | Nudge messages rewritten |
| + retry fix | 93% | 87% | 93% | 100% | `anyAttemptHadToolCalls` |
| + maxSteps=8, temp=0.3 | **98%** | **100%** | **100%** | 93% | Forced earlier synthesis |
| + global override + citation overrides | **100%** | **100%** | **100%** | **100%** | "MUST write text after tools" |

### Validation (30 new prompts, never seen before)

| Mode | Scenarios | Passed | Rate |
|---|---|---|---|
| Chat | 10 | 10 | 100% |
| Search | 10 | 10 | 100% |
| Research | 10 | 10 | 100% |
| **Total** | **30** | **30** | **100%** |

## Key Takeaways

1. **GPT-OSS needs tighter constraints than Sonnet/Mistral.** It gets stuck in tool-calling loops where other models naturally stop and synthesize. Lower `maxSteps` + more retry attempts is the right trade-off.

2. **Nudge language matters enormously.** "RESPOND NOW" causes acknowledgment traps. "You must write your final answer now. Summarize the key facts..." works because it tells the model WHAT to do, not just THAT it should do something.

3. **Retry logic must track state across attempts.** A retry that says "no more tools" will naturally produce no tool calls — the retry condition must account for tool calls from ALL prior attempts.

4. **Per-vendor config is essential.** The same parameters that work for Sonnet (maxSteps=20, temperature=0.2) cause blank responses in GPT-OSS. The vendor config system (`src/ai/prompts/vendors/`) makes these differences explicit and maintainable.
