# LangSmith Integration for Thunderbolt

This module provides LangSmith-specific integrations for tracing and online evaluation.

> **📦 Evaluation System Moved!**
>
> The evaluation framework has been moved to a new, provider-agnostic architecture at:
>
> **`src/evaluation/`**
>
> See [`src/evaluation/README.md`](../evaluation/README.md) for:
>
> - Quick start commands
> - Adding new evaluators
> - Adding new providers
> - Architecture documentation

## What's Still Here

- **`client.ts`** - LangSmith client configuration
- **`online-evaluation.ts`** - Automatic sampling of production traffic

## Quick Start

### 1. Set up environment variables

Add to `.env`:

```bash
# Required
LANGSMITH_API_KEY="lsv2_..."
LANGSMITH_TRACING_ENABLED="true"

# Optional
LANGSMITH_PROJECT="thunderbolt"
LANGSMITH_SAMPLING_RATE="1.0"

# For Quality evaluation (LLM-as-judge)
OPENAI_API_KEY="sk-..."        # or
ANTHROPIC_API_KEY="sk-ant-..."
LLM_JUDGE_MODEL="anthropic:claude-3-5-haiku-20241022"  # default (or openai:gpt-4o-mini)
```

### 2. Sync datasets to LangSmith

```bash
bun run eval:sync           # Sync both datasets
bun run eval:sync behavioral # Only behavioral
bun run eval:sync quality    # Only quality
```

### 3. Run evaluations

```bash
# Make sure backend is running
bun run dev

# In another terminal:
bun run eval:behavioral         # Fast, rule-based checks
bun run eval:behavioral:verbose # With detailed output

bun run eval:quality            # LLM-as-judge evaluation
bun run eval:quality:verbose    # With detailed output

bun run eval:all                # Run both
```

## Architecture

```
src/langsmith/
├── client.ts              # LangSmith client configuration
├── tracing.ts             # Trace helpers for inference calls
├── streaming.ts           # Traced streaming for chat completions
├── online-evaluation.ts   # Automatic evaluation on production traffic
├── dashboard.ts           # Metrics dashboard and API routes
├── index.ts               # Main exports
├── README.md              # This file
└── evaluation/
    ├── behavioral-datasets.ts  # Behavioral test cases
    ├── quality-datasets.ts     # Quality test cases with reference answers
    ├── evaluators.ts           # Rule-based evaluation functions
    ├── llm-judge.ts            # LLM-as-judge evaluators
    ├── run-behavioral.ts       # CLI script for behavioral eval
    ├── run-quality.ts          # CLI script for quality eval (multi-turn)
    ├── sync-dataset.ts         # Sync datasets to LangSmith
    ├── index.ts                # Evaluation exports
    └── quality/                # Multi-turn quality evaluation system
        ├── types.ts            # Type definitions
        ├── executor.ts         # Multi-turn conversation executor
        ├── tool-runner.ts      # Tool execution via backend
        ├── trace-sampler.ts    # Production trace sampling
        ├── index.ts            # Quality module exports
        └── evaluators/         # LLM-as-judge evaluators
            ├── tool-decision.ts   # Tool usage decisions
            ├── tool-execution.ts  # Tool execution quality
            ├── answer-quality.ts  # Final answer quality
            ├── journey.ts         # Conversation path efficiency
            └── index.ts           # Evaluator exports
```

---

## Behavioral Evaluation

> **Purpose**: Verify the model follows structural rules and patterns  
> **Cost**: Free (heuristic evaluators) + 3 LLM judge calls  
> **Speed**: ~2-5 seconds per test case

Tests **how** the model behaves—not whether the answer is correct, but whether it follows the expected patterns: using tools when it should, searching before answering real-time questions, avoiding unnecessary formatting, responding in the user's language, etc.

### What it tests (9 evaluators)

**Heuristic (fast, free):**

| Evaluator          | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `tool_usage`       | Does the model use tools when appropriate? Avoid them when not? |
| `formatting`       | Does it avoid tables when not needed? Respect length limits?    |
| `search_first`     | For real-time queries, does it search before answering?         |
| `response_quality` | Is the response substantial (not empty, not apologies)?         |
| `tool_efficiency`  | Does it use 1-5 tool calls (not 10+ excessive calls)?           |
| `language_match`   | Does it respond in the same language as the user's query?       |

**LLM-as-Judge (Claude):**

| Evaluator               | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `error_recovery`        | Does it handle tool failures gracefully?         |
| `persona_consistency`   | Does it maintain the "executive assistant" tone? |
| `context_summarization` | Does it summarize tool results well?             |

### Running with custom models

```bash
# Use default model (mistral-large-3)
bun run eval:behavioral

# Use specific model
bun run eval:behavioral --model gpt-oss-120b
bun run eval:behavioral --model sonnet-4.5
bun run eval:behavioral --model mistral-medium-3.1
```

**Available models:**

- `mistral-large-3` (default)
- `mistral-medium-3.1`
- `gpt-oss-120b` (Thunderbolt self-hosted)
- `sonnet-4.5` (Claude Sonnet 4.5)

### Test cases

Defined in `behavioral-datasets.ts`:

```typescript
{
  id: 'beh-tool-001',
  name: 'Current weather query',
  messages: [{ role: 'user', content: "What's the weather in SF?" }],
  expectedBehavior: {
    shouldUseTools: true,
    expectedToolCount: { min: 1, max: 3 },
    shouldAvoidTables: true,
    shouldBeSearchFirst: true,
  },
  tags: ['weather', 'tool-required'],
}
```

### When to use

- After every prompt change
- In CI pipelines
- Quick sanity checks

---

## Quality Evaluation

> **Purpose**: Verify the model provides correct, helpful, and well-grounded answers  
> **Cost**: Tool API costs + LLM judge calls (~$0.01-0.08 per test case)  
> **Speed**: ~5-30 seconds per test case (depends on tool calls)

Tests **what** the model answers through **full multi-turn conversation execution** with real tool calls. Unlike behavioral tests, this actually runs the complete conversation flow: the model receives a query, decides to use tools (or not), executes them, and produces a final answer. LLM-as-judge evaluators then assess whether the answer is correct, complete, and properly grounded in the tool results.

### Key Features

- **Real Tool Execution**: Actually calls `web_search` and `fetch_content` via the backend
- **Multi-turn Conversations**: Continues until the model provides a final answer
- **Comprehensive Evaluation**: 4 LLM-as-judge evaluators assess different quality aspects
- **Production Trace Support**: Can evaluate recent production conversations

### What it tests

| Evaluator        | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `tool_decision`  | Did the model make appropriate decisions about when to use tools? |
| `tool_execution` | Were tools used effectively? (good queries, relevant URLs)        |
| `answer_quality` | Is the final answer correct, complete, and well-grounded?         |
| `journey`        | Was the conversation path efficient? (turns, latency)             |

### How it works

```
┌────────────┐     ┌─────────────┐     ┌────────────┐     ┌───────────┐
│ Test Case  │────▶│   Model     │────▶│ Tool Call? │────▶│  Execute  │
│ (query)    │     │ (streaming) │     │            │     │  Tool     │
└────────────┘     └─────────────┘     └────────────┘     └─────┬─────┘
                         ▲                                      │
                         └──────────────────────────────────────┘
                              Loop until final answer
                                 (max 5 turns)
```

### Usage

```bash
# Run with synthetic test cases (executes real tools)
bun run eval:quality

# Run with verbose output
bun run eval:quality:verbose

# Use a specific model
bun run eval:quality -- --model gpt-oss-120b
bun run eval:quality -- --model sonnet-4.5
bun run eval:quality -- --model mistral-medium-3.1

# Evaluate production traces
bun run eval:quality:production
bun run eval:quality -- --production --hours 48
bun run eval:quality -- --production --max 50

# Evaluate specific traces
bun run eval:quality -- --traces "trace-id-1,trace-id-2"
```

### Configuration

| Option               | Description                              | Default                            |
| -------------------- | ---------------------------------------- | ---------------------------------- |
| `--model`, `-m`      | Model to evaluate                        | `mistral-large-3` or `$EVAL_MODEL` |
| `--production`, `-p` | Use production traces                    | synthetic test cases               |
| `--traces`, `-t`     | Specific trace IDs (comma-separated)     | -                                  |
| `--hours`, `-h`      | Hours to look back for production traces | 24                                 |
| `--max`              | Maximum traces to sample                 | 20                                 |
| `--verbose`, `-v`    | Show detailed output                     | false                              |
| `--sync`             | Sync test cases to LangSmith first       | false                              |

### Test cases

Defined in `quality-datasets.ts` with **reference answers**:

```typescript
{
  id: 'qual-fact-001',
  name: 'Company CEO identification',
  category: 'factual',
  messages: [{ role: 'user', content: 'Who is the CEO of Apple?' }],
  referenceAnswer: 'Tim Cook is the CEO of Apple...',
  evaluationCriteria: {
    requiredFacts: ['Tim Cook', 'CEO'],
    requiresCurrentInfo: true,
    lengthGuidance: 'brief',
  },
  tags: ['business', 'factual'],
}
```

### Output example

```
🔬 Thunderbolt Quality Evaluation
════════════════════════════════════════
Backend: http://localhost:8000
Model: mistral-large-3
Max Turns: 5
Timeout: 60s
LLM Judge: openai:gpt-4o-mini

🧪 Running 10 synthetic test cases...

✅ Who is the CEO of Apple?
   Score: 92% | Turns: 2 | Latency: 3.2s | Status: completed

❌ Write a Python function that reverses a string
   Score: 65% | Turns: 1 | Latency: 1.8s | Status: completed

════════════════════════════════════════
📊 QUALITY EVALUATION SUMMARY
════════════════════════════════════════
   Total cases:     10
   Passed:          8/10 (80%)
   Average score:   84.2%
   Average latency: 4.3s
   Average turns:   1.8

📈 Score Breakdown:
   Tool Decision:   89.5%
   Tool Execution:  82.3% (6 cases with tools)
   Answer Quality:  85.1%
   Journey:         79.8%
```

### Cost considerations

Quality evaluation has two cost components:

1. **Tool execution**: Calls to `web_search` (Exa API) and `fetch_content`
2. **LLM-as-judge**: 4 evaluator calls per test case

| Judge Model       | Per test case | 10 test cases |
| ----------------- | ------------- | ------------- |
| gpt-4o-mini       | ~$0.01        | ~$0.10        |
| gpt-4o            | ~$0.08        | ~$0.80        |
| claude-3-5-haiku  | ~$0.01        | ~$0.10        |
| claude-3-5-sonnet | ~$0.04        | ~$0.40        |

### When to use

- Major prompt changes
- Before deploying prompt updates to production
- Quality regression monitoring
- Debugging user-reported issues (use `--traces`)

---

## Adding Test Cases

### Behavioral cases

Add to `behavioral-datasets.ts`:

```typescript
export const newCases: BehavioralCase[] = [
  {
    id: 'beh-custom-001',
    name: 'My new test',
    description: 'Testing specific behavior',
    messages: [{ role: 'user', content: 'Your test query' }],
    expectedBehavior: {
      shouldUseTools: true,
      shouldAvoidTables: true,
    },
    tags: ['custom'],
  },
]
```

### Quality cases

Add to `quality-datasets.ts`:

```typescript
export const newCases: QualityCase[] = [
  {
    id: 'qual-custom-001',
    name: 'My quality test',
    category: 'factual',
    messages: [{ role: 'user', content: 'Your test query' }],
    referenceAnswer: 'The expected correct answer...',
    evaluationCriteria: {
      requiredFacts: ['key fact 1', 'key fact 2'],
      requiresCurrentInfo: false,
      lengthGuidance: 'brief',
    },
    tags: ['custom'],
  },
]
```

After adding cases, sync to LangSmith:

```bash
bun run eval:sync
```

---

## LLM-as-Judge Configuration

Configure via `LLM_JUDGE_MODEL` environment variable (format: `provider:model-name`).

### Anthropic Models (Recommended)

| Model                                  | Use Case                       | Speed  | Cost |
| -------------------------------------- | ------------------------------ | ------ | ---- |
| `anthropic:claude-3-5-haiku-20241022`  | **Default** - Good balance     | Fast   | $    |
| `anthropic:claude-haiku-4-5-20251001`  | Extended thinking capability   | Fast   | $    |
| `anthropic:claude-sonnet-4-5-20250929` | Best for agents & coding       | Medium | $$   |
| `anthropic:claude-3-7-sonnet-20250219` | High performance               | Medium | $$   |
| `anthropic:claude-opus-4-1-20250805`   | Most capable, nuanced judgment | Slow   | $$$  |

### OpenAI Models

| Model                | Use Case                      | Speed  | Cost |
| -------------------- | ----------------------------- | ------ | ---- |
| `openai:gpt-4o-mini` | Cost-effective alternative    | Fast   | $    |
| `openai:gpt-4o`      | Strong at following rubrics   | Medium | $$   |
| `openai:gpt-4-turbo` | Alternative for complex tasks | Slow   | $$$  |

### Accuracy Recommendations

Based on research, for LLM-as-judge evaluation tasks:

1. **Production evaluations**: `claude-sonnet-4-5-20250929` or `claude-opus-4-1`
2. **Daily development**: `claude-3-5-haiku-20241022` (default) - good cost/accuracy
3. **High-stakes decisions**: `claude-opus-4-1-20250805` - most nuanced judgment
4. **OpenAI alternative**: `gpt-4o` - strong at following evaluation rubrics

### Example

```bash
# In .env
ANTHROPIC_API_KEY="sk-ant-..."
LLM_JUDGE_MODEL="anthropic:claude-sonnet-4-5-20250929"  # For production quality
```

---

## Viewing Results in LangSmith

1. Go to [smith.langchain.com](https://smith.langchain.com)
2. Navigate to **Datasets & Testing**
3. Select your dataset:
   - `thunderbolt-behavioral-eval` for behavioral results
   - `thunderbolt-quality-eval` for quality results
4. Click **Experiments** to see evaluation runs
5. Click an experiment to see detailed results per test case

---

## Online Evaluation (Production)

Automatic evaluation runs on sampled production traffic.

### Configuration

```typescript
import { configureOnlineEvaluation } from '@/langsmith'

configureOnlineEvaluation({
  samplingRate: 0.1, // Evaluate 10% of requests
  useLLMJudge: false, // Disable for cost savings in prod
})
```

### Dashboard

Available at `/v1/eval/dashboard` when the server is running.

| Endpoint                 | Description         |
| ------------------------ | ------------------- |
| `GET /v1/eval/dashboard` | HTML dashboard      |
| `GET /v1/eval/metrics`   | Metrics JSON        |
| `GET /v1/eval/health`    | Health check        |
| `GET /v1/eval/debug`     | Debug configuration |

---

## Environment Variables Reference

| Variable                    | Default                               | Description                     |
| --------------------------- | ------------------------------------- | ------------------------------- |
| `LANGSMITH_API_KEY`         | (required)                            | Your LangSmith API key          |
| `LANGSMITH_PROJECT`         | `thunderbolt`                         | Project name in LangSmith       |
| `LANGSMITH_TRACING_ENABLED` | `false`                               | Enable automatic tracing        |
| `LANGSMITH_SAMPLING_RATE`   | `1.0`                                 | Fraction of requests to trace   |
| `THUNDERBOLT_BACKEND_URL`   | `http://localhost:8000`               | Backend URL for eval script     |
| `OPENAI_API_KEY`            | (none)                                | For LLM-as-judge with OpenAI    |
| `ANTHROPIC_API_KEY`         | (none)                                | For LLM-as-judge with Anthropic |
| `LLM_JUDGE_MODEL`           | `anthropic:claude-3-5-haiku-20241022` | Model for LLM-as-judge          |

---

## Troubleshooting

### "Dataset not found"

Run the sync script first:

```bash
bun run eval:sync
```

### "LangSmith not configured"

Check your `.env` has:

```bash
LANGSMITH_API_KEY="lsv2_..."
LANGSMITH_TRACING_ENABLED="true"
```

### Evaluation fails to connect

Make sure the backend is running:

```bash
bun run dev
```

### LLM-as-judge errors

Check you have the appropriate API key:

```bash
# For OpenAI models
OPENAI_API_KEY="sk-..."

# For Anthropic models
ANTHROPIC_API_KEY="sk-ant-..."
```
