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

# Test the legacy engine only
EVAL_ENGINES=legacy bun run eval

# Test only Chat mode across all models
EVAL_MODES=chat bun run eval

# Verbose mode — shows the full system prompt and model response for each scenario
EVAL_MODELS=opus EVAL_MODES=chat bun run eval -- --verbose

# Test Opus in Search mode only
EVAL_MODELS=opus EVAL_MODES=search bun run eval
```

> **Prerequisite**: The backend must be running at `localhost:8000` (or whatever `cloud_url` is configured). Protected model and proxy routes also require a signed bearer in `EVAL_AUTH_TOKEN` unless the Bun environment's local storage is already seeded. The eval runner makes real API calls to the models.

## How It Works

The matrix is derived from `defaultModels`, so every shipped system model is included automatically. Each turn goes through `createBuiltInAdapter`, which applies the same routing as production:

- Tool-capable `anthropic`, `openai`, `custom`, `openrouter`, and `thunderbolt` models use the Pi harness.
- Other models, including `tinfoil`, use the legacy AI pipeline.

```
User prompt → createBuiltInAdapter() → Pi or legacy → UI message stream → Parse & Score
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

| Category                | Prompts | Expected behavior                                                 | Gate |
| ----------------------- | :-----: | ----------------------------------------------------------------- | :--: |
| `never_search`          |   12    | No web calls; correct answer                                      | 95%  |
| `answer_then_offer`     |   12    | Answer without web calls, then explicitly offer to verify         | 80%  |
| `single_search`         |   12    | 1-2 web calls                                                     | 90%  |
| `research`              |   12    | Search in Chat; explicit deep-research wording exhausts 2 calls   | 85%  |
| `unknown_entity`        |    8    | 1-2 web calls                                                     | 85%  |
| `false_premise`         |    8    | Search and explicitly rebut the embedded false premise            | 75%  |
| `adversarial_no_search` |   16    | Resist lexical/recency bait; no web calls; correct answer         | 90%  |
| `multi_turn_reuse`      |   12    | Reuse prior results; two negative controls require a fresh search | 90%  |
| `search_wont_help`      |    4    | Do not fabricate; explicitly admit the answer cannot be verified  | 60%  |

`search_wont_help` is excluded by default and enabled with `EVAL_NECESSITY_OPTIONAL=1`.

The `research` category measures the decision to search in ordinary Chat, not exhaustive depth. Chat resolves to `auto` and production hard-caps it at two executed web calls. Prompts that explicitly say “research,” “deep dive,” or “comprehensive” therefore require both calls; other multi-source prompts require at least one. The existing `/research` suite measures depth under its 30-call budget.

### Example Output

```
============================================================
EVAL REPORT
============================================================

Overall: 12/15 passed (80%)

By Model:
  opus: 12/15 (80%)

By Engine:
  pi: 12/15 (80%)

By Mode:
  chat: 12/15 (80%)

Failures (3):
  FAIL opus/pi/chat/C4
    - Empty response — no text output produced
  FAIL opus/pi/chat/C11
    - Insufficient citations: 0 found, 2 required
  FAIL opus/pi/chat/C15
    - Empty response — no text output produced

============================================================

Report saved to: evals/eval-results-20260804-164000.md
```

## Environment Variables

| Variable                  | Default                             | Example           | Description                                              |
| ------------------------- | ----------------------------------- | ----------------- | -------------------------------------------------------- |
| `EVAL_MODELS`             | all                                 | `opus,glm`        | Model short names to test                                |
| `EVAL_ENGINES`            | all                                 | `pi`              | Engines to test                                          |
| `EVAL_MODES`              | all                                 | `chat,search`     | Modes to test                                            |
| `EVAL_SCENARIO_PARALLEL`  | `3`                                 | `1`               | Concurrent scenarios                                     |
| `EVAL_TIMEOUT`            | `120000`                            | `60000`           | Timeout per turn (ms)                                    |
| `EVAL_OUTPUT`             | `evals/eval-results-<timestamp>.md` | `reports/eval.md` | Report file path                                         |
| `EVAL_AUTH_TOKEN`         | local storage token                 | signed bearer     | Backend bearer used by inference and proxy requests      |
| `EVAL_SAMPLES`            | `3`                                 | `5`               | Samples per necessity scenario; core suites always use 1 |
| `EVAL_SMOKE`              | unset                               | `1`               | Run the fixed smoke subset and force all samples to 1    |
| `EVAL_NECESSITY_OPTIONAL` | unset                               | `1`               | Include `search_wont_help` scenarios                     |

### CLI Flags

| Flag         | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `--verbose`  | Shows the full system prompt and raw model response for each scenario            |
| `--detailed` | Adds a Failures section to the markdown report with prompts, errors, and reasons |

Example with detailed report:

```
$ EVAL_MODELS=opus EVAL_MODES=chat bun run eval -- --detailed

# The timestamped markdown report will include:
## Failures

### opus/pi/chat/C4

- **Prompt**: Compare the iPhone 16 Pro and Samsung Galaxy S25 Ultra
- **Duration**: 60.0s
- **Error**: Scenario timed out
- **Reasons**:
  - Empty response — no text output produced
  - Insufficient citations: 0 found, 2 required
```

Example with verbose:

```
$ EVAL_MODELS=opus EVAL_MODES=chat bun run eval -- --verbose

--- SYSTEM PROMPT (opus/pi/chat/C1) ---
You are an executive assistant using the **Opus 4.8** model...
# Principles
...
# Active Mode (follow these instructions)
Make quick decisions—don't overthink...
--- USER PROMPT ---
What are the top 3 news stories today?
--- END PROMPT ---

  PASS opus/pi/chat/C1 (2.1s)

--- RESPONSE (opus/pi/chat/C1) ---
Here are the three leading stories on AP News for February 16, 2026:
- **Europeans push back at the U.S...** [1]
- **"First feline" Larry marks 15 years...** [2]
- **Ukrainian drone strike sparks fires...** [3]
--- END RESPONSE ---
```

### Model names

Use these names in `EVAL_MODELS`:

- `opus` — Opus 4.8
- `flash` — DeepSeek V4 Flash
- `glm` — GLM 5.2

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

All scenarios are defined in `scenarios.ts`.

### Smoke subset

`EVAL_SMOKE=1` selects a fixed list rather than sampling randomly. Every shipped model/engine cell runs `C1`, `S1`, and `R1`, plus the first prompt from each enabled search-necessity category. With the current matrix that is 11 scenarios per cell and 33 total. Enabling `EVAL_NECESSITY_OPTIONAL=1` adds `search-wont-help-01` per cell.

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
- **`expectSearchOffer`** — Judge checks that the response answered first and explicitly offered to verify
- **`expectPremiseRebuttal`** — Judge checks that the response explicitly corrected the false premise
- **`expectVerificationDisclaimer`** — Judge checks that the response admitted the answer could not be verified

Pi coding tools (`bash`, `read`, `write`, and `edit`) never contribute to web-call counts. Calls emitted after the web budget is exhausted still count because they represent a model decision to call the tool, even when the result is `budget_exhausted`.

### Judge design

Only the four semantic assertions above invoke an LLM judge; deterministic web-call counting never does. DeepSeek V4 Flash judges Opus. Opus judges Flash and GLM. A model never judges itself, and GLM is never a judge because its Tinfoil connection cannot be resolved through the OpenAI-compatible connection used here.

Each scenario sample makes at most one judge call containing the user prompt, final response, and only the declared assertions. Verdicts must be strict JSON. Unsupported correctness claims fail. An API or parsing failure marks that sample as an error rather than passing it.

### Sampling, gates, and headline metrics

Core suites run once. Necessity scenarios run three independent fresh-thread samples by default, and their binary result plus web-call count is reduced to the modal outcome. Two passing samples out of three pass; error samples count as failures.

Category gates use the modal outcomes and report a 95% Wilson score interval. Two cross-category gates catch policy drift:

- **Unnecessary-search rate ≤5%** — share of `never_search`, `answer_then_offer`, `adversarial_no_search`, and non-control `multi_turn_reuse` scenarios whose modal outcome made a web call.
- **Missed-search rate ≤5%** — share of `single_search`, `research`, `unknown_entity`, `false_premise`, and negative-control `multi_turn_reuse` scenarios whose modal outcome made no web call.
- **Mean web calls per no-search-expected prompt** — secondary metric without a gate.

### Metrics JSON

Every report writes `eval-metrics.json` beside the Markdown file. The stable schema is:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-04T12:00:00.000Z",
  "groups": {
    "opus/pi": {
      "model": "opus",
      "engine": "pi",
      "scenarios": {
        "never-search-01": {
          "category": "never_search",
          "passed": true,
          "webToolCalls": 0,
          "duplicateWebToolCalls": 0,
          "sampleCount": 3,
          "passedSampleCount": 3,
          "errorSampleCount": 0,
          "isNegativeControl": false,
          "reviewBy": "2026-11-04",
          "failures": []
        }
      },
      "categories": {
        "never_search": {
          "passed": 12,
          "total": 12,
          "rate": 1,
          "wilson": { "lower": 0.7575, "upper": 1 },
          "threshold": 0.95,
          "gatePassed": true
        }
      },
      "headline": {
        "unnecessarySearchRate": {
          "count": 0,
          "total": 50,
          "rate": 0,
          "threshold": 0.05,
          "gatePassed": true
        },
        "missedSearchRate": {
          "count": 0,
          "total": 42,
          "rate": 0,
          "threshold": 0.05,
          "gatePassed": true
        },
        "meanWebCallsNoSearchExpected": 0
      }
    }
  }
}
```

Rates are fractions from 0 to 1. Groups are keyed by `model/engine`; scenario keys are the human-readable final ID segment. This shape is intended for CI baselines and PR-comment generation.

## CI

The `AI Evals` workflow has two paths:

- Pull requests run the deterministic smoke subset when they change `src/ai/**`, `shared/agent-core/**`, `shared/defaults/**`, `src/acp/**`, or the eval workflow. The report and metrics JSON are uploaded together.
- A nightly run at 03:00 UTC executes the full suite with the default three samples per necessity scenario. It can run for every model/engine cell without multiplying the work by separate before/after revisions.

The pull-request comment is updated in place using a hidden marker. For each model/engine cell it shows gate status, headline rates and baseline deltas, category rates, Wilson significance labels, failed necessity scenarios, and a link to the full report artifact. Deltas are significant only when the current rate falls outside the baseline run's 95% Wilson interval.

### Baselines

Checked-in baselines live in `baselines/` as one `model--engine.json` file per cell. They contain the observed metrics from a full run, not hand-authored targets. Generate or compare them locally from a metrics artifact with:

```bash
bun run eval:baseline -- evals/eval-metrics.json
bun run eval:compare -- evals/eval-metrics.json
```

The nightly workflow regenerates the files and, when they change, force-updates the dedicated `evals/baseline-refresh` branch. It opens a draft pull request if that branch has no open refresh pull request; it never commits directly to `main`.

No baseline files are shipped until the first scheduled run produces real measurements. Before then, comments show `No baseline yet — first scheduled run will create one.` and omit deltas and significance claims.

### CI authentication

Inference, Tinfoil, search, and universal-proxy routes reject unauthenticated requests. The workflow starts an isolated PGlite backend with `AUTH_ALLOW_ANONYMOUS=true`, calls Better Auth's anonymous sign-in endpoint, and reads the signed bearer from its `set-auth-token` response header. It passes that value as `EVAL_AUTH_TOKEN`; the eval attaches it to both its authenticated HTTP client and hosted proxy fetch. This uses the existing test-mode authentication path and does not add an auth bypass.

The repository needs these Actions secrets:

- `ANTHROPIC_API_KEY` — Opus inference and Opus judge calls
- `FIREWORKS_API_KEY` — DeepSeek V4 Flash inference and judge calls
- `TINFOIL_API_KEY` — confidential GLM inference
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
  judge.ts          Cross-model semantic assertions
  stats.ts          Modal sampling, Wilson intervals, gates, and metrics aggregation
  baseline.ts       Baseline file generation and Wilson-based comparisons
  baseline-cli.ts   eval:baseline and eval:compare entry point
  smoke.ts          Deterministic pull-request subset selection
  scoring.ts        Citation extraction, URL validation, criteria checking
  report.ts         Console, markdown, and JSON report generation
  types.ts          Shared type definitions
```

The runner is **not** included in the app build — it's a standalone script that imports from the app's source.
