# AI Eval Runner

Embedded E2E test runner that validates AI response quality across the shipped model and mode matrix. It runs through the production built-in adapter without a browser, Playwright, or MCP server.

## Quick Start

```bash
# Run all scenarios
bun run eval

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

> **Prerequisite**: The backend must be running at `localhost:8000` (or whatever `cloud_url` is configured). The eval runner makes real API calls to the models.

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

| Mode         | What's Checked                                                           |
| ------------ | ------------------------------------------------------------------------ |
| **Chat**     | Must produce output, has `[N]` citations, no review-site links           |
| **Search**   | Must produce output, uses `<widget:link-preview>` tags, no homepage URLs |
| **Research** | Must produce output, has 3-5+ citations                                  |

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

| Variable                 | Default                             | Example           | Description               |
| ------------------------ | ----------------------------------- | ----------------- | ------------------------- |
| `EVAL_MODELS`            | all                                 | `opus,glm`        | Model short names to test |
| `EVAL_ENGINES`           | all                                 | `pi`              | Engines to test           |
| `EVAL_MODES`             | all                                 | `chat,search`     | Modes to test             |
| `EVAL_SCENARIO_PARALLEL` | `3`                                 | `1`               | Concurrent scenarios      |
| `EVAL_TIMEOUT`           | `120000`                            | `60000`           | Timeout per turn (ms)     |
| `EVAL_OUTPUT`            | `evals/eval-results-<timestamp>.md` | `reports/eval.md` | Report file path          |

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

Core suites contain 15 prompts per mode, tested against every model in `defaultModels`. Validation, multi-turn, and widget-regression scenarios add focused coverage. Scenario ids use `model/engine/mode/ID`, such as `opus/pi/chat/C1` and `glm/legacy/search/S3`.

**Chat mode** covers: news queries, product recommendations, factual lookups, comparisons, multi-part travel queries, medical info, stock market data, and more.

**Search mode** covers: news, restaurants, tutorials, research papers, product searches, local businesses, and tricky queries where the model must distinguish individual pages from aggregates.

**Research mode** covers: multi-country analyses, scientific consensus questions, education system comparisons, gene therapy reviews, housing/migration data correlation, and other prompts requiring 5+ searches and 10+ source citations.

**Widget regression** covers spontaneous weather forecasts, link previews, integration connection prompts, interactive questions, and maps, plus factual and coding prompts that must remain plain text. Citation tags are excluded because citation instructions explicitly forbid them. Document-result tags are excluded because they require Document Search mode and tool results, which this runner does not support.

All scenarios are defined in `scenarios.ts`.

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
- **`maxToolCalls`** — Tool calls in the scored turn must not exceed the limit

## Architecture

```
src/ai/eval/
  run.ts            Entry point (bun run eval)
  runner.ts         Builds adapter contexts, runs turns, parses streams, scores results
  stream-parser.ts  Parses AI SDK UIMessageStream protocol
  scenarios.ts      Prompt suites and default-model matrix derivation
  scoring.ts        Citation extraction, URL validation, criteria checking
  report.ts         Console + markdown report generation
  types.ts          Shared type definitions
```

The runner is **not** included in the app build — it's a standalone script that imports from the app's source.
