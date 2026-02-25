# Feasibility Report: AI SDK Subagents for Citation & Link Preview Reliability

**Date:** 2026-02-24
**Branch:** `italomenezes/prompt-separation-by-model-mode`
**Status:** Research complete — no code changes

---

## Executive Summary

**Recommendation: Do NOT adopt subagents for this use case.** The subagent pattern adds significant latency (~3-10s per response) and cost (~2x tokens) without addressing the root problem. Instead, pursue a **Custom Provider + Middleware refactoring** to consolidate the existing 18+ override files into a cleaner architecture, and expand the existing stream-level citation normalization.

The prompt engineering approach, while complex, is the correct lever for the hardest problem: models that omit citations entirely.

---

## Table of Contents

1. [How AI SDK Subagents Work](#1-how-ai-sdk-subagents-work)
2. [Current Project Architecture](#2-current-project-architecture)
3. [Would Subagents Help?](#3-would-subagents-help)
4. [Tradeoff Analysis](#4-tradeoff-analysis)
5. [Alternative Patterns Evaluated](#5-alternative-patterns-evaluated)
6. [Recommended Path Forward](#6-recommended-path-forward)
7. [When Subagents WOULD Make Sense](#7-when-subagents-would-make-sense)
8. [Sources](#8-sources)

---

## 1. How AI SDK Subagents Work

### API Surface

AI SDK 6 subagents are **not a dedicated API** — they're a pattern built on top of `ToolLoopAgent` + `tool()`. A subagent is a `ToolLoopAgent` wrapped as a tool that the parent agent can call. The critical innovation is `toModelOutput`, which decouples what the UI shows from what the parent model consumes.

| Concept | API |
|---|---|
| Define subagent | `new ToolLoopAgent({ model, instructions, tools, stopWhen })` |
| Expose to parent | `tool({ execute: async (input) => subagent.generate({ prompt: input.task }) })` |
| Control parent context | `toModelOutput: ({ output }) => ({ type: 'text', value: summary })` |
| Stream to UI | `execute: async function* () { yield message }` (generator pattern) |
| Structured return | `output: Output.object({ schema: z.object({...}) })` |

### How Subagents Are Spawned

Subagents are invoked via **tool calling**:

```ts
// 1. Define the subagent
const citationSubagent = new ToolLoopAgent({
  model: openai('gpt-4o-mini'),
  instructions: 'You format text with proper [N] citations.',
  tools: {},
});

// 2. Wrap as a tool for the parent
const formatCitations = tool({
  description: 'Format a response with proper citations.',
  inputSchema: z.object({
    text: z.string(),
    sources: z.array(z.object({ index: z.number(), title: z.string() })),
  }),
  execute: async ({ text, sources }, { abortSignal }) => {
    const result = await citationSubagent.generate({
      prompt: `Add [N] citations to this text:\n${text}\n\nSources: ${JSON.stringify(sources)}`,
      abortSignal,
    });
    return result.text;
  },
});
```

### Context Passing

Three levels of context control:

1. **Prompt-only (default):** Subagent receives only the task string. Clean context window.
2. **Full conversation history:** Forward parent's `messages` array to subagent.
3. **`toModelOutput` for return control:** The full UIMessage with all subagent work is shown in UI, but `toModelOutput` maps it to a summary for the parent model (e.g., 1,000 tokens instead of 100,000).

### Key Constraints

- **Sequential by default**: Parent blocks while subagent runs. Parallel only when the LLM emits multiple tool calls in one step (model-dependent, not controllable).
- **Independent context windows**: Each subagent starts fresh unless you explicitly pass `messages`.
- **Streaming supported** via async generators, but adds complexity.
- **Any model**: Subagents can use different models than the parent.
- **Latency warning from docs**: "Subagents add latency and complexity. Use them when the benefits outweigh the costs."

---

## 2. Current Project Architecture

### The AI Fetch Pipeline (4 Layers)

```
Layer 1 — Entry (Client)
  src/chats/detail.tsx → chat-instance.ts → aiFetchStreamingResponse()

Layer 2 — Setup (fetch.ts lines 119-216)
  Parse messages → Save to DB → Resolve model config → Build tools
  → Create sourceCollector[] → Build systemPrompt → Get nudge messages
  → Wrap model with middleware → Get temperature/maxSteps/maxAttempts

Layer 3 — Agentic Loop (fetch.ts lines 250-415)
  while (attempts < maxAttempts) {
    streamText({ model, system, messages, tools, stopWhen, prepareStep })
    → prepareStep: inject nudges, Mistral citation reinforcement
    → writer.merge(result.toUIMessageStream())
    → Check for empty response → Retry with nudge if empty
  }

Layer 4 — Streaming to Client
  createUIMessageStreamResponse → SSE → React state → WidgetRenderer
```

### Prompt Assembly (`createPrompt`)

The system prompt is built from a fixed template with a **3-level override system** (`defaults → vendor → model`), resolved per-mode (`chat/search/research`):

```
[GLOBAL BASE PROMPT]
  - Identity + citation instruction (hardcoded)
  - Principles section (hardcoded)
  - Context section (date, user name, location, preferences)
  - Tools section + overrides.tools (4 layers concatenated)
  - Link Previews section + overrides.linkPreviews (4 layers)
  - Widget Components section (auto-generated from widget instructions.ts)
  - Output Format section (citation rules, hardcoded)
  [OPTIONAL] Active Mode + overrides.modeAddendum (4 layers)
```

The override resolution in `src/ai/prompts/index.ts` collects up to four layers (`vendorGlobal`, `vendorMode`, `modelGlobal`, `modelMode`) and concatenates matching fields.

### Model-Specific Overrides Today

| Vendor | Layer | Override Type | Purpose |
|---|---|---|---|
| openai (all) | vendorConfig | `providerOptions.systemMessageMode: 'developer'` | Forces Chat Completions API |
| openai (all) | global | `tools` addendum | Prevents blank responses after tool calls; non-English query handling |
| openai (all) | chat mode | `modeAddendum` | Forces multiple `[N]` citations per response |
| openai (all) | search mode | `modeAddendum` | Forces `<widget:link-preview>` instead of `[N]` badges |
| openai (all) | research mode | `tools` + `modeAddendum` | Citation minimum count (5+), paragraph-level enforcement |
| gpt-oss-120b | modelConfig | temperature=0.3, maxSteps=8, maxAttempts=4, nudgeThreshold=5 | Reduces tool-call runaway |
| mistral (all) | global | `linkPreviews` + `tools` addendum | Deep-link workflow; mandatory `[N]` per tool call |
| mistral (all) | chat mode | `modeAddendum` | Mandatory `[N]` if tools were used |
| mistral (all) | search mode | `modeAddendum` | Content quality check before link previews |
| mistral (all) | research mode | `modeAddendum` | Citation count enforcement (5+) |

### The Nudge System

Nudges are fake `user`-role messages injected mid-stream by `prepareStep`. Not persisted to the database.

- **`finalStep` nudge**: At `maxSteps - 1`, disables all tools (`activeTools: []`) to force text synthesis.
- **`preventive` nudge**: After `nudgeThreshold` tool-call steps (default 6). Mid-loop reminder to synthesize.
- **`retry` nudge**: After a complete `streamText` run produces zero text. Appended before re-running.

Each vendor gets different wording because identical phrases produce different behaviors:
- GPT-OSS: "RESPOND NOW" causes acknowledgment trap → use softer language
- Mistral: every nudge mentions `[N]` because Mistral's baseline omits citations entirely

### Prompt Size Analysis

Citation/link-preview behavior accounts for **~60-70% of total system prompt tokens** for Mistral in research mode:
- `widget/citation/instructions.ts` + `widget/link-preview/instructions.ts`: ~130 lines
- Base Output Format section: ~6 lines
- Vendor-specific overrides: 2-8 lines per mode per vendor
- Mistral `citationReinforcement`: dynamically appended after every tool-call step

### Critical Shared State: `sourceCollector`

The `sourceCollector: SourceMetadata[]` array is created once before the retry loop as a **closure shared by all tool executions**. Every tool invocation appends with a sequential 1-based index. Tool results include `[Source N]` labels teaching the model which citation number to use.

This is the most significant coupling constraint for any subagent approach — indices must be synchronized across agents.

### Three Natural Subagent Injection Points

**Point A — After retry loop, before streaming to UI (~line 344)**
Spawn subagent to post-process main agent's response. Highest leverage but kills streaming UX.

**Point B — Inside `prepareStep`, between steps (~line 261)**
"Critic" subagent evaluates tool results mid-loop. Async allowed but adds latency per step.

**Point C — As a new tool in toolset**
Least intrusive — `synthesize_citations` tool. But model must decide to call it, and GPT-OSS already struggles with tool call decisions.

---

## 3. Would Subagents Help?

### The Hypothesis

```
Main Agent (tool-calling phase) → produces tool results with [Source N]
  ↓
Citation Subagent (synthesis phase) → takes tool results + source metadata
  → produces properly cited text with [N] references
```

### Why It Sounds Good

- Decouples tool-calling behavior from citation compliance
- Uses a model good at formatting (e.g., Claude Sonnet) even if the main model is GPT-OSS
- Subagent gets a focused, short prompt: "Here are sources. Write a response citing them."
- `toModelOutput` keeps the parent context lean

### Why It Doesn't Work for This Use Case

#### Problem 1: The core problem is unchanged

The research reveals a **fundamental distinction between two problems**:

1. **Citation format normalization** — model cites but uses wrong format (`【1】` instead of `[1]`)
2. **Citation omission** — model produces no citations at all

Mistral's primary issue is #2 (omission). Moving "please cite your sources" from the main system prompt to a subagent's prompt doesn't make a model more likely to comply — it just prompts a different model. If you use a different model for the subagent (e.g., Claude for citation formatting), you're paying for two models to do what one model with good prompting already achieves.

#### Problem 2: Latency

A synthesis subagent adds an entire additional LLM inference pass. For research mode (already 30+ seconds), this adds 3-10 seconds. The user sees a gap of no activity between tool completion and text appearing.

#### Problem 3: Streaming UX

The current architecture streams text as it generates. A post-synthesis subagent either:
- (a) Blocks streaming entirely until it completes, or
- (b) Requires careful stream merging with `sendStart: false` / `sendFinish: false` — which has no test coverage and is fragile

#### Problem 4: Link preview workflow is untouched

The link preview problem is about the main model's **tool-calling behavior** (making too few fetch calls, linking to aggregate pages). A synthesis subagent runs AFTER tool calling — it cannot retroactively make the model fetch more pages.

#### Problem 5: Cost

Each subagent call adds a full inference cycle. For 5 messages/session = 5 extra LLM calls = ~2x token cost.

#### Problem 6: `sourceCollector` synchronization

A subagent that calls its own tools would produce indices that conflict with the main agent's indices. Solvable (via `createConfigs` offset parameter) but fragile and error-prone.

---

## 4. Tradeoff Analysis

| Dimension | Current (Prompt Overrides) | Subagent Approach |
|---|---|---|
| **Latency** | Zero overhead | +3-10s per response |
| **Cost** | Zero overhead | ~2x token cost |
| **Streaming UX** | Real-time text | Gap or complex merging |
| **Citation omission** | Solved (nudges + reinforcement) | Same problem, different agent |
| **Citation format** | Solved (prompt rules) | Solved (subagent formatting) |
| **Link preview workflow** | Solved (prompt overrides) | NOT solved |
| **Code complexity** | 18+ override files | Subagent lifecycle + stream merge + source sync |
| **Testability** | No fetch.ts tests | Even harder to test |
| **Reliability** | Proven (92%+ eval scores) | Unproven, adds failure modes |

---

## 5. Alternative Patterns Evaluated

### 5.1 Tool Calling (Citations as Tools)

Define a `cite` tool with structured arguments `{ sourceIndex, claim }`. Models call the tool instead of writing `[N]` inline.

**Verdict: WORSE.** Fundamentally incompatible with streaming UX — citations appear as separate tool call steps, not inline within sentences. Each citation adds a full inference round-trip. Estimated 3-5x token increase. The streaming UX degradation alone is disqualifying.

### 5.2 Structured Output / `generateObject`

Use `Output.object()` with Zod schema to force structured JSON response separating text and citation metadata.

**Verdict: WORSE.** Cannot mix free-form prose with structure — the entire response becomes JSON. Streaming partial objects produces jerky, unnatural UX. Complete pipeline rewrite required. Very high implementation complexity for degraded UX.

### 5.3 Post-Processing Pipeline

Three sub-approaches:

**A. Regex/Heuristic normalization** — Expand existing `stripBracketCitations` to handle more format variants.
- Verdict: **COMPLEMENTARY.** Low effort, zero cost. But can only normalize existing citations, not add missing ones.

**B. LLM post-processing** — Send completed response to a small model for citation injection.
- Verdict: **WORSE.** Kills streaming UX (must wait for full response). +30-50% cost.

**C. Stream transform** — Use `experimental_transform` to normalize citations in real-time.
- Verdict: **COMPLEMENTARY.** Elegant but limited — `text-delta` chunks may split `[N]` markers across chunks, making regex unreliable.

### 5.4 AI SDK Language Model Middleware

Use `LanguageModelV2Middleware` with `transformParams` (modify system prompt) and `wrapStream` (normalize output).

**Verdict: SAME (better organization).** This is the existing approach in a different architecture. `transformParams` replaces the override resolver. `wrapStream` handles format normalization. But middleware cannot inject citations that the model never produced. The biggest win is consolidating 18+ files into per-model middleware stacks. **The project already uses `wrapLanguageModel` with `extractReasoningMiddleware` — this extends the pattern.**

### 5.5 Custom Provider Wrapper

Create a `customProvider` that wraps all model providers with per-model middleware stacks:

```ts
const thunderboltProvider = customProvider({
  languageModels: {
    'gpt-oss-120b': wrapLanguageModel({
      model: openai.chat('gpt-oss-120b'),
      middleware: [
        extractReasoningMiddleware({ tagName: 'think' }),
        citationNormalizationMiddleware(),
        gptOssSettingsMiddleware(),
      ],
    }),
    'mistral-medium-3.1': wrapLanguageModel({
      model: mistralProvider('mistral-medium-3.1'),
      middleware: [
        extractReasoningMiddleware({ tagName: 'think' }),
        citationNormalizationMiddleware(),
        mistralCitationMiddleware(),
      ],
    }),
  },
})
```

**Verdict: SAME (better encapsulation).** Replaces `createModel()` + `getModelConfig()` + `getPromptOverrides()` with a single provider definition. Type-safe model IDs. Per-model middleware stacks. **Worth pursuing as a refactoring target regardless of the citation problem.**

### Summary Matrix

| Alternative | Solves Missing Citations? | Solves Format Issues? | Solves Link Preview? | Streaming UX | Complexity | Cost | Verdict |
|---|---|---|---|---|---|---|---|
| **Tool Calling** | Partially | Yes | No | Severe degradation | High | 3-5x | **Worse** |
| **Structured Output** | Partially | Yes | No | Severe degradation | Very High | +10-20% | **Worse** |
| **Regex Post-Processing** | No | Yes | No | None | Low | None | **Complementary** |
| **LLM Post-Processing** | Yes | Yes | No | Kills streaming | Medium | +30-50% | **Worse** |
| **Stream Transform** | No | Partially | No | None | Medium | None | **Complementary** |
| **Middleware** | No | Yes | No | None | Low-Medium | None | **Same (better org)** |
| **Custom Provider** | No | Yes | No | None | Medium | None | **Same (better org)** |
| **Subagents** | No* | Yes | No | Degradation | High | ~2x | **Worse** |

*Subagents move the prompting problem to a different context — they don't eliminate it.

---

## 6. Recommended Path Forward

### Priority 1: Custom Provider + Middleware Refactoring (Medium effort, High impact on code org)

Consolidate the 18+ override files into per-model middleware stacks within a `customProvider`. This:
- Collapses `getPromptOverrides()` + `getModelConfig()` + `createModel()` into a single provider
- Gives each model its own middleware stack
- Uses the existing `wrapLanguageModel` pattern already in `fetch.ts`
- Does NOT change behavior — pure architectural improvement

### Priority 2: Citation Normalization Middleware (Low effort, Medium impact)

Add a `citationNormalizationMiddleware` with `wrapStream` that normalizes format variants:
- `【1】` → `[1]` (OpenAI fullwidth brackets)
- `[Source 1]` → `[1]` (Mistral verbose format)
- `(1)` → `[1]` (parenthetical style)
- Expand existing `stripBracketCitations` in `widget-parser.ts` as a complementary client-side fallback

### Priority 3: Keep Prompt Engineering (No effort, High behavioral impact)

The nudge system and `prepareStep` citation reinforcement are the **correct solution** for citation omission. They work (92%+ eval scores). Keep them, but consolidate into the middleware architecture.

### Priority 4: Skip Subagents (No effort)

Re-evaluate if/when adding a deep-research mode that parallelizes search, or a fact-checking post-synthesis step where latency is acceptable.

---

## 7. When Subagents WOULD Make Sense

Subagents are the right tool when:
- The task requires **exploring large token volumes** that would overflow the parent context
- You need to **parallelize independent research** across multiple subagents
- You want to **isolate tool access** by capability domain

Future Thunderbolt use cases where subagents would be appropriate:
- **Deep research mode**: Multiple subagents search/fetch in parallel, each returning summaries via `toModelOutput`
- **Code analysis**: Subagent reads entire files without bloating the main context
- **Fact-checking**: Post-synthesis subagent verifies claims against sources (opt-in, latency acceptable)
- **Multi-model routing**: Different subagents for different query types (search vs. analysis vs. creative)

---

## 8. Sources

### AI SDK Documentation
- [Subagents](https://ai-sdk.dev/docs/agents/subagents)
- [ToolLoopAgent Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
- [Agent Interface Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/agent)
- [Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [Agents Overview](https://ai-sdk.dev/docs/agents/overview)
- [Workflow Patterns](https://ai-sdk.dev/docs/agents/workflows)
- [Language Model Middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)
- [Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Custom Provider](https://ai-sdk.dev/docs/reference/ai-sdk-core/custom-provider)
- [Provider Management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)
- [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [streamText Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [generateText Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)
- [createAgentUIStream Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-agent-ui-stream)
- [Error Handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)
- [Stopping Streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- [smoothStream](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
- [Track Agent Token Usage](https://ai-sdk.dev/cookbook/next/track-agent-token-usage)
- [Tool Calling with Structured Outputs (Troubleshooting)](https://ai-sdk.dev/docs/troubleshooting/tool-calling-with-structured-outputs)

### Vercel Blog
- [AI SDK 6 Announcement](https://vercel.com/blog/ai-sdk-6)
- [AI SDK 4.1 (Stream Transforms)](https://vercel.com/blog/ai-sdk-4-1)
- [AI SDK 3.4 (Language Model Middleware)](https://vercel.com/blog/ai-sdk-3-4)

### External
- [Build a Multi-Agent Research System with AI SDK 6 — Chris McKenzie (Medium)](https://medium.com/@kenzic/build-a-multi-agent-research-system-with-ai-sdk-6-5bb5b24452b4)
- [Exploring LLM Citation Generation in 2025](https://medium.com/@prestonblckbrn/exploring-llm-citation-generation-in-2025-4ac7c8980794)
- [How AI Engines Cite Sources](https://medium.com/@shuimuzhisou/how-ai-engines-cite-sources-patterns-across-chatgpt-claude-perplexity-and-sge-8c317777c71d)
- [Perplexity Architecture](https://www.frugaltesting.com/blog/behind-perplexitys-architecture-how-ai-search-handles-real-time-web-data)
- [Environment-Aware Model Routing with AI SDK](https://blog.logrocket.com/environment-aware-model-routing/)
- [Constrained Decoding for LLMs](https://brics-econ.org/constrained-decoding-for-llms-how-json-regex-and-schema-control-improve-output-reliability)
- [Taming LLM Outputs: Structured Text Generation](https://www.dataiku.com/stories/blog/your-guide-to-structured-text-generation)
- [Sub Agent Starter Template](https://aisdkagents.com/templates/sub-agent-starter)

### Codebase Files Analyzed
- `src/ai/fetch.ts` — Main orchestrator
- `src/ai/step-logic.ts` — Agentic loop decisions
- `src/ai/prompt.ts` — System prompt assembly
- `src/ai/prompts/index.ts` — 3-level override resolver
- `src/ai/prompts/types.ts` — VendorConfig/PromptOverride types
- `src/ai/prompts/vendors/defaults.ts` — Base config
- `src/ai/prompts/vendors/openai/config.ts` — OpenAI vendor config
- `src/ai/prompts/vendors/openai/models/gpt-oss-120b/config.ts` — GPT-OSS model config
- `src/ai/prompts/vendors/openai/global.ts` — GPT-OSS overrides
- `src/ai/prompts/vendors/openai/search.ts` — GPT-OSS search mode
- `src/ai/prompts/vendors/openai/nudges.ts` — GPT-OSS nudge wording
- `src/ai/prompts/vendors/mistral/global.ts` — Mistral overrides
- `src/ai/prompts/vendors/mistral/citation-reinforcement.ts` — Dynamic reinforcement
- `src/ai/prompts/vendors/mistral/nudges.ts` — Mistral nudge wording
- `src/ai/widget-parser.ts` — Widget tag parser
- `src/ai/message-metadata.ts` — Source registry metadata
- `src/ai/middleware/tool-calls.ts` — Tool call stream parser
- `src/ai/middleware/think-block.ts` — Think block stream parser
- `src/widgets/index.ts` — Widget registry
- `src/widgets/citation/instructions.ts` — Citation AI instructions
- `src/widgets/link-preview/instructions.ts` — Link preview AI instructions
- `src/integrations/thunderbolt-pro/tools.ts` — Tool definitions + sourceCollector
- `src/lib/tools.ts` — Tool registry builder
- `src/chats/chat-instance.ts` — Chat SDK wiring
- `src/components/chat/text-part.tsx` — Widget rendering pipeline
