# AI Eval Runner

Embedded E2E test runner that validates AI response quality across all models and chat modes. Calls the AI pipeline directly — no browser, no Playwright, no MCP server needed.

## Quick Start

```bash
# Run all 135 scenarios (3 models x 3 modes x 15 prompts)
bun run eval

# Test only GPT-OSS
EVAL_MODELS=gpt-oss bun run eval

# Test only Chat mode across all models
EVAL_MODES=chat bun run eval

# Verbose mode — shows the full system prompt and model response for each scenario
EVAL_MODELS=gpt-oss EVAL_MODES=chat bun run eval -- --verbose

# Test GPT-OSS in Search mode only
EVAL_MODELS=gpt-oss EVAL_MODES=search bun run eval

# Test Mistral and Sonnet in Chat and Search modes
EVAL_MODELS=mistral,sonnet EVAL_MODES=chat,search bun run eval
```

> **Prerequisite**: The backend must be running at `localhost:8000` (or whatever `cloud_url` is configured). The eval runner makes real API calls to the models.

## How It Works

The runner calls `aiFetchStreamingResponse()` directly — the same function the app uses when you send a chat message. This means it tests the **exact same code path**: prompt assembly, tool calls, retries, nudges, and streaming.

```
User prompt → aiFetchStreamingResponse() → Model API → Stream response → Parse & Score
                    ↑                                                         ↓
              Same function                                            Pass/Fail report
              the app uses
```

Each scenario gets its own in-memory database (via `setupTestDatabase()`), so tests are fully isolated and safe to run in parallel.

## What It Tests

Each scenario checks a combination of criteria depending on the mode:

| Mode         | What's Checked                                                           |
| ------------ | ------------------------------------------------------------------------ |
| **Chat**     | Must produce output, has `[N]` citations, no review-site links           |
| **Search**   | Must produce output, uses `<widget:link-preview>` tags, no homepage URLs |
| **Research** | Must produce output, has 3-5+ citations                                  |

### Example Output

```
Thunderbolt AI Eval Runner
========================================
Scenarios: 15
Models: gpt-oss
Modes: chat
Parallel: 3 (one per model)
Timeout: 120000ms per scenario
========================================

Starting batch: gpt-oss

--- GPT-OSS (15 scenarios) ---
  PASS gpt-oss/chat/C1 (2.1s)
  PASS gpt-oss/chat/C2 (4.3s)
  PASS gpt-oss/chat/C3 (1.8s)
  FAIL gpt-oss/chat/C4 (60.0s) — Empty response — no text output produced
  PASS gpt-oss/chat/C5 (1.2s)
  ...

============================================================
EVAL REPORT
============================================================

Overall: 12/15 passed (80%)

By Model:
  gpt-oss: 12/15 (80%)

By Mode:
  chat: 12/15 (80%)

Failures (3):
  FAIL gpt-oss/chat/C4
    - Empty response — no text output produced
  FAIL gpt-oss/chat/C11
    - Insufficient citations: 0 found, 2 required
  FAIL gpt-oss/chat/C15
    - Empty response — no text output produced

============================================================

Report saved to: evals/eval-results.md
```

## Environment Variables

| Variable                 | Default                 | Example           | Description                     |
| ------------------------ | ----------------------- | ----------------- | ------------------------------- |
| `EVAL_MODELS`            | all                     | `gpt-oss,mistral` | Which models to test            |
| `EVAL_MODES`             | all                     | `chat,search`     | Which modes to test             |
| `EVAL_SCENARIO_PARALLEL` | `3`                     | `1`               | Concurrent scenarios per worker |
| `EVAL_TIMEOUT`           | `120000`                | `60000`           | Timeout per scenario (ms)       |
| `EVAL_OUTPUT`            | `evals/eval-results.md` | `reports/eval.md` | Report file path                |

### CLI Flags

| Flag         | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `--verbose`  | Shows the full system prompt and raw model response for each scenario            |
| `--detailed` | Adds a Failures section to the markdown report with prompts, errors, and reasons |

Example with detailed report:

```
$ EVAL_MODELS=gpt-oss EVAL_MODES=chat bun run eval -- --detailed

# The markdown report at evals/eval-results.md will include:
## Failures

### gpt-oss/chat/C4

- **Prompt**: Compare the iPhone 16 Pro and Samsung Galaxy S25 Ultra
- **Duration**: 60.0s
- **Error**: Scenario timed out
- **Reasons**:
  - Empty response — no text output produced
  - Insufficient citations: 0 found, 2 required
```

Example with verbose:

```
$ EVAL_MODELS=gpt-oss EVAL_MODES=chat bun run eval -- --verbose

--- SYSTEM PROMPT (gpt-oss/chat/C1) ---
You are an executive assistant using the **GPT OSS** model...
# Principles
...
# Active Mode (follow these instructions)
Make quick decisions—don't overthink...
--- USER PROMPT ---
What are the top 3 news stories today?
--- END PROMPT ---

  PASS gpt-oss/chat/C1 (2.1s)

--- RESPONSE (gpt-oss/chat/C1) ---
Here are the three leading stories on AP News for February 16, 2026:
- **Europeans push back at the U.S...** [1]
- **"First feline" Larry marks 15 years...** [2]
- **Ukrainian drone strike sparks fires...** [3]
--- END RESPONSE ---
```

### Model names

Use these names in `EVAL_MODELS`:

- `gpt-oss` — GPT OSS 120B (self-hosted)
- `mistral` — Mistral Medium 3.1
- `sonnet` — Sonnet 4.5

### Mode names

Use these names in `EVAL_MODES`:

- `chat` — Concise responses with citations
- `search` — Link preview widgets only
- `research` — Exhaustive research with many citations

## Scenarios

135 total scenarios: 15 prompts per mode, tested against each of 3 models.

**Chat mode** covers: news queries, product recommendations, factual lookups, comparisons, multi-part travel queries, medical info, stock market data, and more.

**Search mode** covers: news, restaurants, tutorials, research papers, product searches, local businesses, and tricky queries where the model must distinguish individual pages from aggregates.

**Research mode** covers: multi-country analyses, scientific consensus questions, education system comparisons, gene therapy reviews, housing/migration data correlation, and other prompts requiring 5+ searches and 10+ source citations.

All scenarios are defined in `scenarios.ts`.

## Scoring

The runner automatically checks:

- **`mustProduceOutput`** — Response text must not be empty
- **`minCitations`** — Minimum count of `[N]` citation markers
- **`mustUseLinkPreviews`** — Must contain `<widget:link-preview url="...">` tags
- **`noHomepageLinks`** — URLs must have deep paths (no `/` or `/section/` only)
- **`noReviewSites`** — No links to pcmag.com, cnet.com, wirecutter.com, etc.
- **`maxSteps`** — Tool call count must not exceed limit

## Architecture

```
src/ai/eval/
  run.ts            Entry point (bun run eval)
  runner.ts         Calls aiFetchStreamingResponse, parses stream, scores result
  stream-parser.ts  Parses AI SDK UIMessageStream protocol
  scenarios.ts      All 135 test scenarios with criteria
  scoring.ts        Citation extraction, URL validation, criteria checking
  report.ts         Console + markdown report generation
  types.ts          Shared type definitions
```

The runner is **not** included in the app build — it's a standalone script that imports from the app's source.
