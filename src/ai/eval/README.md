# AI Eval Runner

Embedded E2E test runner that validates AI response quality across the shipped model and mode matrix. It runs through the production built-in adapter without a browser, Playwright, or MCP server.

## Quick Start

```bash
# Run all scenarios
bun run eval

# Run the deterministic pull-request smoke subset
EVAL_SMOKE=1 bun run eval

# Test only Opus
EVAL_MODELS=opus bun run eval

# Test the Pi engine only
EVAL_ENGINES=pi bun run eval

# Test only Chat mode across all models
EVAL_MODES=chat bun run eval

# Run one suite in isolation — the whole point when iterating on it
EVAL_SUITES=language bun run eval

# Verbose mode — shows the full system prompt and model response for each scenario
EVAL_MODELS=opus EVAL_MODES=chat bun run eval -- --verbose

# Test Opus in Search mode only
EVAL_MODELS=opus EVAL_MODES=search bun run eval
```

> **Prerequisite**: The backend must be running at `localhost:8000` (or whatever `cloud_url` is configured). Protected model and proxy routes require a signed bearer in `EVAL_AUTH_TOKEN`. The eval runner makes real API calls to the models.

## How It Works

The matrix is derived from `defaultModels`, so every shipped system model is included automatically. Each turn goes through `createBuiltInAdapter`, which applies the same routing as production:

- Every shipped eval model uses the Pi harness, including confidential models through their confidential transport.

```
User prompt → createBuiltInAdapter() → Pi harness → UI message stream → Parse & Score
```

One in-memory database is initialized for the run and shared read-only by all scenarios. Each scenario gets a fresh thread id, which is reused across that scenario's turns so persistent Pi harness behavior matches production. The adapter is disconnected after the run.

## What It Tests

Each scenario checks a combination of criteria depending on the mode:

| Mode         | What's Checked                                                                   |
| ------------ | -------------------------------------------------------------------------------- |
| **Chat**     | Must produce output; fresh prompts require citations while stable prompts do not |
| **Search**   | Must produce output, uses `<widget:link-preview>` tags, no homepage URLs         |
| **Research** | Must produce output, has 3-5+ citations                                          |

### Search-necessity taxonomy

Necessity scenarios use plain Chat turns, so the production `auto` web budget applies. They multiply across the same model/engine matrix as the core suites.

| Category                | Prompts per cell | Expected behavior                                                                   | Gate |
| ----------------------- | ---------------: | ----------------------------------------------------------------------------------- | ---: |
| `never_search`          |               19 | Correct stable/code answers or weather widgets; no web or research-skill load       |  95% |
| `answer_then_offer`     |                8 | Correct scoped answer, freshness caveat and offer; no web/research load             |  80% |
| `single_search`         |               23 | 1–2 web calls, supported answer covering the narrow question, no research load      |  90% |
| `research`              |               26 | Successful research-skill load and evidence-backed coverage of requested dimensions |  85% |
| `unknown_entity`        |                8 | 1–2 web calls, no research load; routing-only under Q3                              |  85% |
| `false_premise`         |                8 | Verify and rebut; support the central correction in 1–3 calls; no research load     |  75% |
| `adversarial_no_search` |               19 | Correct task completion despite search bait; no web/research load                   |  90% |
| `multi_turn_reuse`      |               10 | Nine faithful recalls of requested values; one new-lookup control                   |  90% |
| `search_wont_help`      |                4 | Admit inability to verify; 0–2 tolerated calls, no research load                    |  60% |

There are 125 definitions per cell, 121 enabled by default. `search_wont_help` is enabled with
`EVAL_NECESSITY_OPTIONAL=1`; it and unknown entities gain no implicit evidence-coverage assertion.
The single search-positive reuse control remains routing-only. Every semantic expectation is
bound to its declared assertion; routing and skill requirements are deterministic criteria.

Weather uses the weather widget, which retrieves its own data; the five weather scenarios belong to
`never_search` and require the existing `weather-forecast` widget assertion, zero web calls and no
research-skill load. Both weather pairs now check widget output on each turn, retaining their IDs.
React setup requires the supported release tag and publication date, without mandatory prerelease prose.
False-premise evidence support is graded only for the central corrected fact, not background history or
side details. Reuse accepts the requested earlier value without unrequested time/channel qualifiers;
it still forbids substituting a newer or remembered value. Correctness grading is unchanged.

The approved Round 1 table retains the 96 existing IDs, adds all 27 PoC prompts under `poc-*-01`,
and adds `verify-electron-01` / `verify-monorepo-01` guidance→verification pairs. Mozilla/visa cases
move to narrow search; WebGPU gets a bounded support overview. Version questions mean latest
non-prerelease, and match questions permit sourced no-fixture results. The three English/Portuguese
PoC pairs additionally check reply language. No gate was lowered.

Research keeps existing minima of one or two emitted web calls; retained PoC research requires two.
There is no scenario maximum. A successful research-skill load now promotes an ordinary Chat turn
to an absolute 30-call budget, preserving spent calls, cache and source IDs; `/search` and `/research`
retain their 12/30 caps. `WEB_BUDGET_PROMOTION=on|off` is a run/lab option (unset means on; other
values fail at budget construction), not a product setting. Eval records expose the current/scored
turn’s `initialCap`, `finalCap` and `promoted`; a later user turn starts fresh. No live result is claimed.

### Reply-language suite

Scores the `# Language` section of the system prompt (`src/ai/prompt.ts`): the model must
answer in the conversation's language, stay there when foreign-language content shows up
mid-thread, switch on an explicit request, and fall back to the app language when a turn
establishes none. Scenarios live in `language-scenarios.ts` and run as Chat turns across
the same model/engine matrix. `language` shares the scored-category machinery (samples,
gate, scenario SEM interval) but is **not** a search-necessity category — `stats.ts` excludes it
from the search headline rates.

| Scenario                       | Shape                                            | Expected reply |
| ------------------------------ | ------------------------------------------------ | -------------- |
| `language-establish-01`        | Portuguese question                              | Portuguese     |
| `language-establish-02`        | Japanese question                                | Japanese       |
| `language-sticky-paste-01`     | pt thread, follow-up pastes an English traceback | Portuguese     |
| `language-sticky-search-01`    | pt question that must search (English sources)   | Portuguese     |
| `language-explicit-switch-01`  | pt thread, follow-up asks for English            | English        |
| `language-fallback-code-01`    | bare code, no prose                              | app language   |
| `language-fallback-terse-01`   | `hm?`                                            | app language   |
| `language-negative-control-01` | ordinary English question                        | English        |

Gate: 95%, matching `never_search` — following an explicit output-language instruction is
close to deterministic for a capable model.

The app language is process-global and scenarios run concurrently, so it belongs to the
**run**, not to a scenario. Under Bun there is no `localStorage` at import time and no
`navigator.languages`, so it resolves to `en` unless `EVAL_LANGUAGE` is set:

```bash
# Conversation-language adherence and stickiness — app language stays `en`,
# so a Portuguese reply proves the conversation beat the setting.
EVAL_MODELS=opus EVAL_MODES=chat bun run eval

# Exercises the fallback: the two fallback scenarios now expect Japanese.
EVAL_LANGUAGE=ja EVAL_MODELS=opus EVAL_MODES=chat bun run eval
```

Every other scenario states its expected language outright, so the suite is valid under
any `EVAL_LANGUAGE` — only the fallback scenarios follow the run.

Language is judged semantically (`replyLanguage` in `judge.ts`), scoped to the assistant's
own prose: quoted error text, code, identifiers, URLs, and proper nouns carry their own
language and do not fail the assertion.

## Environment Variables

Generation and judge deadlines must be positive finite numbers.

| Variable                  | Default                 | Example           | Description                                              |
| ------------------------- | ----------------------- | ----------------- | -------------------------------------------------------- |
| `EVAL_MODELS`             | all                     | `opus,glm`        | Model short names to test                                |
| `EVAL_ENGINES`            | all                     | `pi`              | Engines to test                                          |
| `EVAL_MODES`              | all                     | `chat,search`     | Modes to test                                            |
| `EVAL_SCENARIO_PARALLEL`  | `3`                     | `1`               | Concurrent scenarios                                     |
| `EVAL_TIMEOUT`            | `600000`                | `60000`           | Generation deadline per attempt (ms)                     |
| `EVAL_JUDGE_TIMEOUT`      | `60000`                 | `30000`           | Timeout per judge attempt (ms)                           |
| `EVAL_OUTPUT`             | `evals/eval-results.md` | `reports/eval.md` | Report file path                                         |
| `EVAL_AUTH_TOKEN`         | local storage token     | signed bearer     | Backend bearer used by inference and proxy requests      |
| `EVAL_SAMPLES`            | `3`                     | `5`               | Samples per necessity scenario; core suites always use 1 |
| `EVAL_SMOKE`              | unset                   | `1`               | Run the fixed smoke subset and force all samples to 1    |
| `EVAL_NECESSITY_OPTIONAL` | unset                   | `1`               | Include `search_wont_help` scenarios                     |
| `EVAL_SUITES`             | all                     | `language`        | Suites to run: `core`, `necessity`, `language`           |
| `EVAL_LANGUAGE`           | `en`                    | `ja`              | App language for the run; reply-language fallback target |

### CLI Flags

| Flag         | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `--verbose`  | Shows the full system prompt and raw model response for each scenario            |
| `--detailed` | Adds a Failures section to the markdown report with prompts, errors, and reasons |

### Model names

Use these names in `EVAL_MODELS`:

- `opus` — Opus 5
- `flash` — GLM 5.3 Flash
- `glm` — GLM 5.3

The slug map is intentionally explicit. Its unit test fails when `defaultModels` gains an entry without a stable eval slug.

### Engine names

Use these names in `EVAL_ENGINES`:

- `pi` — In-memory Pi harness with coding and app tools
- `legacy` — Existing AI SDK pipeline

### Mode names

Use these names in `EVAL_MODES`:

- `chat` — Concise responses with citations
- `search` — Link preview widgets only
- `research` — Exhaustive research with many citations

## Scenarios

Core suites contain 15 prompts per mode, tested against every model in `defaultModels`. Validation, multi-turn, widget-regression, and search-necessity scenarios add focused coverage. Scenario ids use `model/engine/mode/ID`, such as `opus/pi/chat/C1`, `glm/legacy/search/S3`, and `flash/pi/chat/never-search-03`.

**Chat mode** covers: news queries, product recommendations, factual lookups, comparisons, multi-part travel queries, medical info, stock market data, and more.

**Search mode** covers: news, restaurants, tutorials, research papers, product searches, local businesses, and tricky queries where the model must distinguish individual pages from aggregates.

**Research mode** covers: multi-country analyses, scientific consensus questions, education system comparisons, gene therapy reviews, housing/migration data correlation, and other prompts requiring 5+ searches and 10+ source citations.

**Widget regression** covers spontaneous weather forecasts, link previews, integration connection prompts, interactive questions, and maps, plus factual and coding prompts that must remain plain text. Citation tags are excluded because citation instructions explicitly forbid them. Document-result tags are excluded because they require Document Search mode and tool results, which this runner does not support.

Core scenarios are in `scenarios.ts`; necessity and language definitions have their own files.

### Smoke subset

`EVAL_SMOKE=1` selects a fixed list rather than sampling randomly. Every shipped model/engine cell runs `C1`, `S1`, and `R1`, plus the first prompt from each enabled search-necessity category. Core plus necessity smoke remains 11 scenarios per cell (33 total); the default all-suite run also includes two language cases per cell (39 total). Enabling `EVAL_NECESSITY_OPTIONAL=1` adds `search-wont-help-01` per cell.

Smoke mode always uses one sample, even when `EVAL_SAMPLES` is set. The explicit IDs and invariant tests keep the subset stable and reviewable while limiting pull-request runtime.

## Scoring

The runner automatically checks:

- **`mustProduceOutput`** — Response text must not be empty
- **`minCitations`** — Minimum count of `[N]` citation markers
- **`mustUseLinkPreviews`** — Must contain `<widget:link-preview url="...">` tags
- **`mustUseWidget`** — Must contain the configured widget tag
- **`mustNotUseWidgets`** — Must not contain any widget tag
- **`noHomepageLinks`** — URLs must have deep paths (no `/` or `/section/` only)
- **`noReviewSites`** — No links to pcmag.com, cnet.com, wirecutter.com, etc.
- **`maxSteps`** — Completed model steps must not exceed the limit
- **`minToolCalls`** — Built-in web calls (`search` and `fetch_content`) must meet the minimum
- **`maxToolCalls`** — Built-in web calls in the scored turn must not exceed the limit
- **`noDuplicateToolCalls`** — No repeated web call with the same tool name and finalized input
- **`expectCorrectAnswer`** — Judge checks factual or functional correctness
- **`expectSearchOffer`** — Answered from knowledge, offered to verify, and included an explicit freshness caveat
- **`expectEvidenceCoverage`** — Material claims are supported by supplied evidence and the requested question is covered
- **`expectReuseFidelity`** — The answer faithfully reuses an earlier turn’s result
- **`expectPremiseRebuttal`** — Judge checks that the response explicitly corrected the false premise
- **`expectVerificationDisclaimer`** — Judge checks that the response admitted the answer could not be verified
- **`expectResearchSkill`** — Deterministically require or forbid a successful research-instruction load in the scored turn; attempted, failed, unrelated or earlier-turn loads do not satisfy it

Pi coding tools (`bash`, `read`, `write`, and `edit`) never contribute to web-call counts. Calls emitted after the web budget is exhausted still count because they represent a model decision to call the tool, even when the result is `budget_exhausted`.

### Judge design

Semantic assertions use an LLM judge; routing, skill and web-call checks remain deterministic. Opus judges every model, including itself, because confidential models cannot be reached through the judge's OpenAI-compatible connection. The "never judges itself" rule is suspended until another direct managed model is available.

The approved necessity rubric declares correctness for stable/no-search answers, correctness plus
search-offer/caveat for dated guidance, evidence coverage for single search and research, and rebuttal
plus coverage for false premises. Faithful reuse declares first-turn coverage and final-turn reuse
fidelity. Unknown entities and new-lookup reuse controls stay routing-only; `search_wont_help` declares
only its verification disclaimer. Paired Portuguese/English cases also check reply language.

Correctness is checked against the judge's own knowledge of the timeless fact or task. Incorrect or unsupported claims fail that assertion, but the response does not need sources or citations. The other assertions are independent: correctness requirements do not affect whether the response offered to search, rebutted a false premise, or admitted it could not verify an answer.

Each trial grades its saved final answer against declared assertions and stores the whole verdict.
Judge explanations are requested under 500 characters. Evidence includes publication date, page status,
and retrieval/crawl/observation timestamps when supplied; retrieval time is not proof of live observation.
A provider error, timeout, malformed JSON, missing assertion or schema mismatch gets one re-grade
of that answer (two judge attempts total), each with its own `EVAL_JUDGE_TIMEOUT` deadline.
Completed behavioural rejections are never re-graded.

### Assertion-bound expectations and turns

`expectation` maps **declared semantic assertion names** to guidance under the matching judge
assertion. Unbound or deterministic keys are rejected: routing, tool limits and other deterministic
rules are expressed by their criteria values, not expectation prose. `expectSearchOffer` uses two verdict fields:
`searchOffer` (knowledge answer plus offer) and `freshnessCaveat`; both must be true. A bare offer
does not supply a caveat. `verificationDisclaimer` still means admitting inability to verify.
Undeclared non-null assertion values are ignored and stored as null; each completed judge attempt
records their count in `judgeUndeclaredFields`. Missing declared assertions still trigger a re-grade;
re-grading replaces earlier semantic failures.

`scenario.criteria` and `scenario.expectation` always describe the final turn. For multi-turn
scenarios, `promptCriteria` / `promptExpectation` optionally grade the first prompt. Intermediate
follow-up objects have `{ prompt, criteria?, expectation? }`; plain strings still work and declare
no setup assertions. Turns never inherit each other’s criteria. Put final-turn criteria on the
scenario: declaring them again on the last follow-up is a definition error.

```ts
{
  prompt: 'Give a rough population estimate from memory.',
  promptCriteria: { mustProduceOutput: true, expectSearchOffer: true },
  promptExpectation: { expectSearchOffer: 'Scope the estimate by year and offer to verify.' },
  followUps: [{ prompt: 'Yes, please verify it.' }],
  criteria: { mustProduceOutput: true, expectEvidenceCoverage: true },
  expectation: { expectEvidenceCoverage: 'Use the supplied current primary-source estimate.' },
}
```

Each reached declared turn is graded and retained in `attempt.turnResults`, with its complete
verdict and judge attempts. A failed setup assertion stops the trajectory as a quality failure;
a setup judge error stays an execution error. The existing scored-turn-not-reached diagnostic
and headline exclusion remain unchanged. Generation and judge time are accounted separately.

The judge receives labelled user/assistant turns and grades the last supplied answer. Raw source
bodies enter **only** for `expectEvidenceCoverage`; other assertions, including reuse fidelity,
receive conversation text without tool bodies. Sources retain their originating turn and `[N]`
index: Turn 1 Source [1] and Turn 2 Source [1] are distinct. Search snippets count when sufficient.
Coverage requires both support and adequate scope: honest missing coverage still fails; missing
pages cannot support claims, while a valid technical article about HTTP 404 is not a soft-404.

### Opt-in judge calibration

`fixtures/poc-excerpts.json` contains excerpts extracted with `jq` from
`/Users/admin/dev/thunderbolt/evals/poc-autopromocao-2026-09-15/flash.samples.json`, record
`flash/pi/chat/promotion-mesh-vpn-fleet`. The extraction selects only the prompt, relevant answer
paragraphs, and `toolCalls[].output.details` for Tailscale pricing and ZeroTier members; it never
copies preflight credentials. The stored Tailscale page says "$0 for up to 6 users" while the
answer says "≤3 users"; the ZeroTier members page says "Page Not Found".

Eight frozen cases cover supported snippet evidence, the contradicted number, invalid-source
support, honest incompleteness, insufficient/sufficient caveats, a synthetic valid HTTP-404 article,
and a context-dependent follow-up. The positive/caveat/context cases are authored controls using
the extracted excerpts where relevant, not claims that the original model produced those answers.

After explicit approval, with the same backend URL setting and signed `EVAL_AUTH_TOKEN` as evals:

```bash
EVAL_JUDGE_CALIBRATION=1 bun run eval:calibrate
```

This spends judge inference and generates no answers. It refuses without the explicit flag or
signed token, prints expected/observed labels per fixture, and exits 0 for all matches, 1 for any
mismatch, or 2 for setup/refusal errors. Run it before interpreting the first reference run and
after changing the judge prompt or rubric. `bun run test` exercises only injected judges; this
round does not execute the real calibration command. Judge prompt version is `round-4-v1`.

### Trials, attempts and retries

Core suites run once; necessity and language default to three independent trials. Each trial has
an ID `scenario ID/index` and retains every attempt, parsed turn, tool call, SSE error, verdict and
generation/judge duration. Execution (`completed`, `timeout`, `infra_error`, `judge_error`) and
behaviour (`pass`, `fail`, `unknown`) are independent.

Only evidence-classified generation infrastructure errors get one fresh-thread retry.
For HTTP 429 or rate-limit SSE failures, the runner waits for `Retry-After` (seconds or HTTP date)
before that retry, with a maximum wait of 60 seconds. An absent, invalid, zero or past value uses
60 seconds; a valid delay above that window remains an infrastructure error without retrying early.
The failed attempt records `retryDecision` (`waited` or `not_retried_delay_over_window`) and, only
when waiting, `retryWaitMs`. The stream retains the observed status and Retry-After value, including
metadata from stream-reader exceptions.
The manifest records effective worker count in `scenarioConcurrency`, including the default and selection cap.
For an isolated lab backend, the existing `RATE_LIMIT_ENABLED=false` knob disables backend admission
limits; production defaults remain enabled (the shared pro tier is 100 requests per 60 seconds).
This knob does not change retry counts, evaluation gates or paid inference quotas. Unclassified
adapter exceptions retain their message/stack and remain non-retryable error trials; the run continues.
A proven deterministic violation blocks retry and counts as a valid failure, as do timeouts with
preserved partial streams. Unresolved infrastructure/judge errors without a proven failure count
against reliability. Recovered `toolInfraError`, `toolMisuse` and `budgetDenial` events are diagnostic.

### Aggregation and acceptance

Each required scenario has `(c, f, e, n)`: passed valid trials, failed valid trials, error trials
and planned trials. Missing completions remain in `e`, so `c+f+e=n`. Triage displays two labels:

| Counts  | Behaviour | Completeness |
| ------- | --------- | ------------ |
| (2,0,1) | pass      | partial      |
| (1,1,1) | flaky     | partial      |
| (0,0,3) | none      | error        |

Behaviour is pass/flaky/fail/none over valid trials; completeness is complete/partial/error.
These labels never gate. Category quality is the **equal-weight mean of scenario `c/(c+f)`**,
using required scenarios with valid trials. Existing percentage thresholds apply to that point
estimate. A category is `not_applicable` when unselected, `unmeasured` if any required scenario
has no valid trials or coverage is below 80%, otherwise `pass` or `fail`.

Consistency `pass^3` is `C(c,3)/C(c+f,3)`, averaged over scenarios with at least three valid trials,
with eligible/required coverage. It is omitted for smoke or samples below three. End-to-end
`mean(c/n)` is diagnostic. Uncertainty uses `mean ± 1.96·s/√m` over scenario means, flags fewer
than five scenarios or zero variance, and warns that paraphrase families are correlated.
There is no binomial/Wilson quality interval or statistical-significance claim.

Headline rates use **valid necessity trials and scored-turn bounds**, excluding language and
`search_wont_help`: `maxToolCalls=0` means no search expected, `minToolCalls>0` means search
expected, otherwise unconstrained. Attempts explicitly record whether the scored turn was reached.
A setup-only failure or timeout remains a quality failure, but is excluded from both headline
denominators and counted in the per-cell “scored turn not reached” diagnostic. Setup streams
remain available as evidence and never supply the scored turn’s call counts. Unnecessary-search and missed-search rates both gate at
≤5%; mean web calls with no search expected is diagnostic. Unselected headline denominators
are `not_applicable`, not a failing 0/0.

Reports lead with per-cell verdicts from the `acceptEval` policy shared by CLI, report, PR comment
and baseline comparison:

1. Exit **2** for a harness crash or any cell's post-retry error rate above **10%**.
2. Otherwise exit **1** for any failed/unmeasured required category or headline, any failed/error
   core trial, or missing required cell/category/scenario.
3. Otherwise exit **0**. Partial runs still cannot establish definition-of-done evidence.

First-attempt errors include recovered judge errors and report generation/judge counts separately.
That rate and the pooled post-retry error rate are diagnostic; reliability gates apply per cell.

### Artifacts and manifest

Schema **4** stores the manifest, every trial, aggregates and crash status in `eval-metrics.json`.
Scenario keys are full IDs. `eval-trials.jsonl` starts with the manifest and appends each completed
trial, preserving work on a crash. A new invocation replaces these artifacts and the Markdown report
at `EVAL_OUTPUT` (default above).

The manifest declares required cells, selected suites/scenarios, planned samples, provider kind,
and the measurement identity and treatment fields listed under Baselines below.
It copies only this settings allowlist:
`EVAL_MODELS`, `EVAL_ENGINES`, `EVAL_MODES`, `EVAL_SUITES`, `EVAL_SAMPLES`, `EVAL_TIMEOUT`,
`EVAL_JUDGE_TIMEOUT`, `EVAL_SCENARIO_PARALLEL`, `EVAL_SMOKE`, `EVAL_LANGUAGE`,
`EVAL_NECESSITY_OPTIONAL`, `WEB_BUDGET_PROMOTION`.
Auth is only `present`/`absent`; tokens, Authorization values and cookies are redacted at every
artifact boundary. The preflight reads `/config.webToolsProvider` or records `unknown` when
that field is absent. The runner captures its model/profile/context and budget observations;
adapter-internal prompt/tools capture is deferred by the final scope decision. Records carry
`promptCapture: "unavailable"` and `toolsCapture: "unavailable"` by design; runner-visible preflight
is the agreed capture for the measurement phase.

### Baselines and PR comments

Baseline files remain one `model--engine.json` per cell. Regeneration rejects filtered/partial
runs and missing required matrix cells before changing files. Offline commands:

```bash
bun run eval:baseline -- evals/eval-metrics.json
bun run eval:compare -- evals/eval-metrics.json
```

Comparison requires matching rubric hash, judge prompt version, actual judge model ID, samples,
generation/judge deadlines, provider kind, cell aliases and actual generation model IDs (not DB UUIDs).
Mismatches name the field as **not comparable**; old schemas are never reinterpreted. Comparable pairs
report scenario `c/(c+f)` deltas. Generation commit plus optional `EVAL_OVERLAY_COMMIT`, system-prompt
source hash and `WEB_BUDGET_PROMOTION` are treatments: they may differ and are printed side by side.

Sticky PR comments use shared acceptance, compact cell/gate summaries, at most 20 diagnostics
(prompt, expected, observed) and bounded treatment comparisons. Full tables/manifests are linked
artifacts. The workflow remains manual-dispatch only.

### CI authentication

Inference, Tinfoil, search, and universal-proxy routes reject unauthenticated requests. The workflow starts an isolated PGlite backend with `AUTH_ALLOW_ANONYMOUS=true`, calls Better Auth's anonymous sign-in endpoint, and reads the signed bearer from its `set-auth-token` response header. It passes that value as `EVAL_AUTH_TOKEN`; the eval entrypoint registers Happy DOM and seeds the production token store before creating adapters, so direct inference, Tinfoil, search, and hosted-proxy transports all use the same bearer. The DOM environment is required because the production adapter's auth and confidential-model cache seams intentionally use browser storage. This uses the existing test-mode authentication path and does not add an auth bypass.

The repository needs these Actions secrets:

- `ANTHROPIC_API_KEY` — Opus inference and Opus judge calls
- `TINFOIL_API_KEY` — inference for confidential models
- `EXA_API_KEY` — web search tool calls

### Manual runs

Open **Actions → AI Evals → Run workflow**. The default `full` choice runs the complete suite; `smoke` runs the pull-request subset, and `both` runs both jobs. The full job checks out `main` so a manual baseline refresh always represents the branch that pull requests compare against.

### Freshness maintenance

Every necessity prompt carries an ISO `reviewBy` date roughly three months after authoring. The Markdown report warns when a date is past due. Review those prompts quarterly: refresh time-sensitive wording and facts, reclassify prompts whose freshness bucket changed, then move `reviewBy` forward.

## Architecture

```
src/ai/eval/
  run.ts            Entry point (bun run eval)
  runner.ts         Builds adapter contexts, runs turns, parses streams, scores results
  stream-parser.ts  Parses AI SDK UIMessageStream protocol
  scenarios.ts      Prompt suites and default-model matrix derivation
  necessity-scenarios.ts Search-necessity taxonomy and prompt metadata
  judge.ts          Turn-aware assertions, evidence scope and verdict validation
  turns.ts          Legacy-compatible turn normalization and definition checks
  fixtures/         Frozen source excerpts and calibration cases
  calibrate.ts      Opt-in live-judge calibration (injected in unit tests)
  stats.ts          Manifest, trial aggregation, scenario SEM and shared acceptance
  baseline.ts       Identity-gated paired scenario comparisons
  baseline-cli.ts   eval:baseline and eval:compare entry point
  smoke.ts          Deterministic pull-request subset selection
  scoring.ts        Citation extraction, URL validation, criteria checking
  report.ts         Console, markdown, and JSON report generation
  types.ts          Shared type definitions
```

The runner is **not** included in the app build — it's a standalone script that imports from the app's source.
