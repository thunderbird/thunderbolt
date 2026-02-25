# Solving Citation Omission Without Better Prompts

**Date:** 2026-02-24
**Context:** Some models (especially Mistral Medium) omit citations entirely despite prompt instructions. This document explores non-prompt architectural solutions.
**Related:** [Subagent Feasibility Report](./subagent-feasibility-report.md), [experimental_transform Research](./experimental-transform-research.md)

---

## The Problem

Thunderbolt has two distinct citation failure modes:

1. **Citation format errors** — Model cites but uses wrong format (`【1】` instead of `[1]`). Solvable with stream transforms / regex normalization.
2. **Citation omission** — Model produces no citations at all. **This document addresses this problem.**

Mistral Medium's primary failure is #2. The model receives tool results labeled `[Source N] (cite as [N])`, generates a well-written response using that information, but simply never writes `[N]` markers. The current fix is aggressive prompt engineering: per-step `citationReinforcement` via `prepareStep`, per-mode `modeAddendum` overrides, and nudge messages that explicitly mention `[N]`.

The question: **what else can you do when a model just won't cite?**

---

## How Tool Results Currently Present Sources

From `src/integrations/thunderbolt-pro/tools.ts`:

```ts
// Search tool result (line 74):
{ sourceLabel: `[Source ${sourceIndex}] (cite as [${sourceIndex}])`, sourceIndex, ...result }

// Fetch tool result (line 118):
{ sourceLabel: `[Source ${sourceIndex}] (cite as [${sourceIndex}])`, sourceIndex, ...result }
```

The tool descriptions also hint at citation:
```ts
// Search (line 46):
'Search the web. Each result has a [Source N] label. Cite with [N] at end of sentence.'

// Fetch (line 80-81):
'Fetch and parse content from a PUBLIC webpage URL. Result has a [Source N] label. Cite with [N] at end of sentence.'
```

The `sourceCollector` array (`src/ai/fetch.ts`) accumulates all source metadata across all tool calls and is available as a closure throughout the streaming pipeline. This is the key data structure for any post-hoc citation solution.

---

## Approach 1: Post-hoc NLI-Based Citation Injection

### How It Works

After the model generates text (with or without citations), a lightweight Natural Language Inference (NLI) model checks each sentence against the source documents in `sourceCollector`. If a sentence is "entailed" by a source (confidence > threshold), a `[N]` marker is injected automatically.

```
Model output:
  "Fortaleza was founded in 1726. It is the fifth largest city in Brazil."

NLI checks each sentence against sourceCollector[]:
  "Fortaleza was founded in 1726" → entailed by Source 1 (score: 0.94) → inject [1]
  "It is the fifth largest city"  → entailed by Source 1 (score: 0.87) → inject [1]

Result:
  "Fortaleza was founded in 1726. It is the fifth largest city in Brazil. [1]"
```

### Academic Foundations

This is a well-researched approach:

- **SAFE framework** ([arxiv 2505.12621](https://arxiv.org/html/2505.12621v2)) — Sentence-level Attribution FramEwork for RAG. Achieves 95% accuracy predicting which sentences need citations, then attributes them to retrieved documents. Two-step: predict reference count, then attribute.
- **MIRAGE** ([arxiv 2406.13663](https://arxiv.org/html/2406.13663v1)) — Uses model internals (attention saliency) to detect context-sensitive answer tokens and pair them with source documents. Achieves citation quality comparable to self-citation prompting.
- **ContextCite** ([github.com/MadryLab/context-cite](https://github.com/madrylab/context-cite)) — Attributes LLM statements back to specific parts of context using perturbation-based methods. MIT licensed, pip installable.
- **CiteGuard** ([arxiv 2510.17853](https://arxiv.org/pdf/2510.17853)) — Retrieval-aware agent framework for citation validation. Improves baseline by 17%, approaching human-level performance (68.1% vs 69.7%).
- **VeriCite** ([arxiv 2510.11394](https://arxiv.org/pdf/2510.11394)) — Uses NLI-based verification in both generation and evidence selection stages.
- **CiteFix** — Two-step citation correction approach: generate first, fix citations second.

### NLI Models for This Task

| Model | Size | Speed | Use Case |
|---|---|---|---|
| `cross-encoder/nli-deberta-v3-base` | 86M params | <50ms/sentence | Best accuracy/speed tradeoff |
| `cross-encoder/nli-deberta-v3-small` | 44M params | <30ms/sentence | Faster, slightly less accurate |
| `facebook/bart-large-mnli` | 406M params | ~100ms/sentence | Zero-shot classification variant |
| `tasksource/deberta-base-long-nli` | 86M params | <50ms/sentence | Handles longer passages |

### Implementation Options

**Option A: `experimental_transform` with sentence buffering**

Run NLI incrementally as text streams. Buffer text until a sentence boundary, check against sources, inject `[N]`, flush:

```ts
const nliCitationTransform = <TOOLS extends ToolSet>(
  sourceCollector: SourceMetadata[]
): StreamTextTransform<TOOLS> =>
  ({ tools }) => {
    let buffer = '';

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type !== 'text-delta') {
          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.textDelta;

        // Check for sentence boundaries
        const sentenceEnd = buffer.match(/[.!?]\s+/);
        if (sentenceEnd) {
          const sentence = buffer.slice(0, sentenceEnd.index! + 1);
          const rest = buffer.slice(sentenceEnd.index! + sentenceEnd[0].length);

          // Run NLI against sources (sync or cached)
          const citation = findBestSource(sentence, sourceCollector);
          const citedSentence = citation
            ? `${sentence} [${citation.index}]`
            : sentence;

          controller.enqueue({ ...chunk, textDelta: citedSentence + ' ' });
          buffer = rest;
        }
      },

      flush(controller) {
        if (buffer) {
          const citation = findBestSource(buffer, sourceCollector);
          const cited = citation ? `${buffer} [${citation.index}]` : buffer;
          controller.enqueue({ type: 'text-delta', textDelta: cited } as any);
        }
      },
    });
  };
```

**Option B: Post-generation pass**

After `streamText` completes, iterate over the full text and inject citations:

```ts
const injectCitations = (text: string, sources: SourceMetadata[]): string => {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.map(sentence => {
    const match = findBestSource(sentence, sources);
    return match ? `${sentence} [${match.index}]` : sentence;
  }).join(' ');
};
```

### The Key Challenge: Running NLI in Bun

Thunderbolt runs on Bun, not Node. Typical NLI models run via Python (HuggingFace Transformers) or ONNX Runtime. Options:

1. **HTTP microservice** — Run a tiny Python FastAPI server with the NLI model, call it from Bun. Adds ~50ms per sentence + network overhead.
2. **ONNX Runtime for Node/Bun** — `onnxruntime-node` works in Bun. Load a quantized NLI model directly. No Python needed.
3. **LLM-as-NLI** — Use a cheap LLM (GPT-4o-mini) as the entailment checker. More expensive per call but zero infrastructure.
4. **Simple heuristic** — TF-IDF or keyword overlap between sentence and source text. Much less accurate but zero dependencies.

### Pros

- Completely model-agnostic — works regardless of which LLM generates text
- Does not modify the generation pipeline (prompt, tools, model config unchanged)
- Well-researched with proven accuracy (~90% sentence-level)
- Can be applied selectively (only for vendors/models with omission problems)

### Cons

- Requires shipping or calling an NLI model (infrastructure complexity)
- Streaming option (A) adds latency per sentence (~50-100ms)
- Post-generation option (B) breaks streaming UX
- May produce incorrect attributions for sentences with information from model's parametric knowledge (not from sources)
- Sentence boundary detection is imperfect with markdown, lists, code blocks

### Verdict

**Most architecturally correct long-term solution.** This is what Perplexity, academic systems, and production RAG pipelines converge on. But infrastructure complexity (NLI model hosting) makes it a medium-term investment, not a quick win.

---

## Approach 2: Tool Result Restructuring via `toModelOutput`

### How It Works

Instead of hoping the model notices `sourceLabel` in the tool result, restructure how tool results are presented to the model using AI SDK's `toModelOutput`. This controls what the model sees without changing what the UI renders.

Currently, tool results are returned as-is — the model sees a JSON object with `sourceLabel`, `sourceIndex`, `url`, `title`, `text`, etc. The `sourceLabel` is just one field among many.

With `toModelOutput`, you can aggressively format the model-facing view:

```ts
{
  name: 'search',
  description: 'Search the web.',
  parameters: searchSchema,
  execute: async (params) => { /* ... returns full structured data ... */ },

  // Control what the MODEL sees (separate from what UI/history stores)
  toModelOutput: ({ output: results }) => {
    return results.map(r => [
      `═══ SOURCE [${r.sourceIndex}] ═══`,
      `Title: ${r.title}`,
      `URL: ${r.url}`,
      `Summary: ${r.summary}`,
      ``,
      `⚠️ MANDATORY: Write [${r.sourceIndex}] after any sentence using this information.`,
      `═══════════════════════════`,
    ].join('\n')).join('\n\n');
  },
}
```

### Why It's More Effective Than System Prompt Instructions

System prompt instructions are read once at the start. By the time the model has processed 5 tool results and is writing its response, the citation instructions are thousands of tokens away in the context window. Models with weaker instruction-following (Mistral) lose track.

`toModelOutput` places the citation instruction **immediately adjacent to the source data** — the model reads "MANDATORY: Write [3]" right before using Source 3's content. This is the highest-salience position for an instruction.

### Current vs Proposed

**Current tool result (model sees):**
```json
{
  "sourceLabel": "[Source 1] (cite as [1])",
  "sourceIndex": 1,
  "url": "https://example.com",
  "title": "Example Article",
  "summary": "...",
  "text": "..."
}
```

**Proposed (model sees via toModelOutput):**
```
═══ SOURCE [1] ═══
Title: Example Article
URL: https://example.com
Summary: ...

⚠️ CITE AS [1] — Place [1] after any sentence using this information.
═══════════════════
```

The UI and message history still store the full structured result. Only the model's view changes.

### Implementation

This requires switching tool definitions from the current `ToolConfig` pattern to direct AI SDK `tool()` definitions with `toModelOutput`. The current `createToolset()` wrapper in `src/lib/tools.ts` would need to support `toModelOutput` passthrough.

### Pros

- Zero latency impact — no extra model calls, no post-processing
- Zero cost impact — same number of tokens (potentially fewer if you trim verbose fields)
- Preserves streaming UX completely
- Easy to A/B test — try different formatting per vendor
- Works within the existing AI SDK tool API

### Cons

- Still relies on the model to follow instructions — just places them more strategically
- Not truly model-agnostic — may help Mistral but is unnecessary for models that already cite
- `toModelOutput` is relatively new in AI SDK 6 — less battle-tested
- Requires refactoring `createToolset()` to support `toModelOutput`

### Verdict

**Best quick win.** Low effort, zero cost, and addresses the root cause (instructions too far from data) rather than the symptom. Should be the first thing to try before more complex approaches.

---

## Approach 3: Cheap "Citation Fixer" Post-Pass

### How It Works

After `streamText` completes but before the response is finalized, check if the text contains citations. If not (or too few), run a single `generateText` call with a fast/cheap model whose only job is adding `[N]` markers:

```ts
// After streamText completes:
const responseText = await result.text;
const citationCount = (responseText.match(/\[\d+\]/g) || []).length;

if (citationCount < expectedMinimum && sourceCollector.length > 0) {
  const fixed = await generateText({
    model: openai('gpt-4o-mini'),
    system: `Add citation markers [N] to the following text.
Each source has an index number. Place [N] after the last sentence that uses information from Source N.
Do not change any words in the text. Only add [N] markers.
Follow this format exactly: "Sentence using source info. [1]"`,
    prompt: `Text to cite:\n${responseText}\n\nAvailable sources:\n${
      sourceCollector.map(s => `[${s.index}] ${s.title}: ${s.description?.slice(0, 200)}`).join('\n')
    }`,
  });

  // Emit the fixed text instead
  // (requires buffering the original stream or emitting a correction)
}
```

### Cost Analysis

- GPT-4o-mini: ~$0.15/1M input tokens, ~$0.60/1M output tokens
- Typical response: ~500 tokens input + ~500 tokens output = ~$0.000375
- At 1000 messages/day: ~$0.38/day
- Only triggered for Mistral (or any model failing citation threshold)

### Streaming Tradeoff

This approach **cannot preserve real-time streaming** for the affected model. Two strategies:

**Strategy A: Buffer entire response, then stream the fixed version**
- User sees tool call activity streaming normally
- Text phase is buffered silently (~2-3 seconds)
- Fixed text streams out via `smoothStream` for natural appearance
- UX: slightly delayed text appearance, but text arrives already cited

**Strategy B: Stream original, then patch**
- User sees uncited text streaming in real-time
- After completion, run fixer, and emit a "correction" that updates the message
- UX: citations "pop in" after the message finishes — jarring but transparent

Strategy A is better. The delay is only noticeable for Mistral, and the result is higher quality.

### Implementation Location

Fits naturally into the retry loop in `fetch.ts` (lines 340-380). After `result.response` is awaited and text is extracted:

```ts
// After line ~370 in fetch.ts:
const text = extractTextFromMessages(response.messages)
const hasCitations = /\[\d+\]/.test(text)

if (!hasCitations && sourceCollector.length > 0 && model.vendor === 'mistral') {
  // Run citation fixer
  const fixedResult = await generateText({ ... })
  // Emit fixed text to writer
}
```

### Pros

- High reliability — GPT-4o-mini is excellent at this simple transformation task
- Cheap ($0.0004 per response)
- Can be vendor-gated (only run for Mistral)
- Does not modify the main generation pipeline
- Simple to implement and test

### Cons

- Adds 500ms-1s latency for affected vendor
- Breaks real-time streaming for affected vendor (must buffer)
- Doubles model calls for affected vendor
- The fixer model could introduce errors (change text, hallucinate citations)
- Need to handle the case where fixer output doesn't match expected format

### Verdict

**Best medium-term pragmatic solution.** Higher reliability than `toModelOutput`, lower complexity than NLI. The streaming tradeoff is acceptable if gated to Mistral only.

---

## Approach 4: Client-Side Heuristic Citation Injection

### How It Works

Move citation injection entirely to the client rendering layer. After a message is complete, check if it has citations. If not, match sentences to `message.metadata.sources` using keyword overlap:

```ts
// In text-part.tsx or a new utility:
const injectFallbackCitations = (text: string, sources: SourceMetadata[]): string => {
  if (/\[\d+\]/.test(text)) return text; // Already has citations

  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.map(sentence => {
    const bestMatch = sources.reduce((best, source) => {
      const overlap = calculateKeywordOverlap(sentence, source.description ?? '');
      return overlap > best.score ? { source, score: overlap } : best;
    }, { source: null as SourceMetadata | null, score: 0 });

    if (bestMatch.source && bestMatch.score > 0.3) {
      return `${sentence} [${bestMatch.source.index}]`;
    }
    return sentence;
  }).join(' ');
};

const calculateKeywordOverlap = (sentence: string, sourceText: string): number => {
  const sentenceWords = new Set(sentence.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const sourceWords = new Set(sourceText.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const intersection = [...sentenceWords].filter(w => sourceWords.has(w));
  return intersection.length / sentenceWords.size;
};
```

### Integration Point

In `src/components/chat/text-part.tsx`, the `buildSourceCitationPlaceholders` function already processes text for citation rendering. A fallback could be added:

```ts
// Before citation placeholder building:
const textWithCitations = hasCitations(content)
  ? content
  : injectFallbackCitations(content, sources);
```

### Pros

- Zero latency (runs client-side after rendering)
- Zero cost (no model calls)
- Zero infrastructure (no NLI model, no API calls)
- Does not touch the AI pipeline at all
- Easy to A/B test with a feature flag

### Cons

- Low accuracy — keyword overlap is a crude heuristic
- Citations "pop in" after message completes (not inline during streaming)
- May misattribute sentences to wrong sources
- Doesn't work for sentences that paraphrase rather than directly use source language
- Sentence splitting is fragile with markdown (lists, headers, code blocks)

### Verdict

**Lowest effort fallback.** Better than nothing for uncited responses, but accuracy is too low to be the primary solution. Best used as a safety net behind better approaches.

---

## Approach 5: Perplexity-Style Multi-Agent Verification

### How It Works

Based on Perplexity's documented architecture, their "Comet" enterprise mode uses three coordinated agents:

1. **Retrieval agent** — Collects source passages (Thunderbolt already does this via search/fetch tools)
2. **Synthesis agent** — Generates text conditioned on retrieved passages
3. **Verification agent** — Validates citations against live sources before final output

The verification agent is the key differentiator. It's not a full subagent — it's a focused check:

```
For each [N] citation in the response:
  - Does the cited sentence actually come from Source N?
  - Is Source N still accessible and does it contain the claimed information?
  - If no citation exists for a sentence that uses source info, add one.
```

### Why Thunderbolt Doesn't Need the Full Pattern

Thunderbolt already has steps 1 and 2. The gap is step 3 (verification/injection). This could be implemented as:

- A `prepareStep` check on the final step that verifies citations before text is emitted
- A post-completion `generateText` call (same as Approach 3 but with verification focus)
- An NLI-based check (same as Approach 1)

### Pros

- Proven at scale (Perplexity handles millions of queries)
- Highest reliability when all three stages are present
- Citations are verified, not just injected

### Cons

- Full implementation requires 3 separate model calls per response
- Cost: 3x current token usage
- Latency: 3x current response time
- Massive overengineering for Thunderbolt's current scale

### Verdict

**Not recommended as-is.** The full Perplexity pattern is for a search engine at massive scale. However, the **verification concept** (check citations after generation) is valuable and can be implemented cheaply as Approach 3.

---

## Recommendation: Tiered Implementation

### Tier 1 — Do Now (Low effort, immediate impact)

**`toModelOutput` restructuring (Approach 2)**

Restructure tool results so citation instructions appear immediately adjacent to source data. This is the highest-leverage change with zero cost and zero latency impact.

Key changes:
- Add `toModelOutput` to search and fetch_content tool definitions
- Format model-facing output with prominent `[N]` citation instructions per source
- Keep full structured data for UI/history storage

Estimated effort: 1-2 hours. Can be A/B tested per vendor via eval system.

### Tier 2 — Do Next (Medium effort, high reliability)

**Cheap citation fixer for Mistral (Approach 3)**

Single `generateText` call with GPT-4o-mini to inject citations when the primary model omits them. Vendor-gated, only runs when `citationCount < threshold`.

Key changes:
- Add citation count check after `streamText` completes in `fetch.ts`
- For Mistral: buffer text, run fixer, stream fixed version
- For other vendors: no change

Estimated effort: 4-8 hours. Cost: ~$0.38/day at 1000 messages.

### Tier 3 — Investigate (High effort, best long-term)

**NLI-based incremental injection (Approach 1)**

Implement as an `experimental_transform` that buffers sentences, runs NLI checks, and injects `[N]` markers in real-time. This is the architecturally correct solution used by production RAG systems.

Key questions to answer first:
- Can ONNX Runtime run in Bun reliably?
- What's the per-sentence latency with a quantized DeBERTa model?
- How does sentence splitting handle markdown/widget tags?

Estimated effort: 2-4 days research + implementation. Zero ongoing cost if using local model.

### Skip

**Client-side heuristic injection (Approach 4)** — Too low accuracy to be useful.
**Full Perplexity pattern (Approach 5)** — Overengineered for current scale.

---

## Sources

### Academic Papers
- [SAFE: Sentence-level Attribution FramEwork](https://arxiv.org/html/2505.12621v2) — 95% accuracy predicting citation needs
- [MIRAGE: Model Internals-based RAG Explanations](https://arxiv.org/html/2406.13663v1) — Saliency-based attribution
- [ContextCite (MIT, MadryLab)](https://github.com/madrylab/context-cite) — Perturbation-based attribution toolkit
- [CiteGuard: Faithful Citation Attribution](https://arxiv.org/pdf/2510.17853) — Retrieval-aware citation validation
- [VeriCite: Towards Reliable Citations](https://arxiv.org/pdf/2510.11394) — NLI-based verification
- [Attribution, Citation, and Quotation: A Survey](https://arxiv.org/html/2508.15396v1) — Comprehensive survey of 134 papers
- [Generation-Time vs Post-hoc Citation](https://arxiv.org/html/2509.21557) — Holistic evaluation of approaches
- [Ground Every Sentence: Interleaved Reference-Claim Generation](https://arxiv.org/html/2407.01796)
- [Concise and Sufficient Sub-Sentence Citations](https://arxiv.org/html/2509.20859v1)
- [Automatic Citation Validation Using NVIDIA NIM](https://developer.nvidia.com/blog/developing-an-ai-powered-tool-for-automatic-citation-validation-using-nvidia-nim/)
- [Citekit: Modular Toolkit for LLM Citation Generation](https://ui.adsabs.harvard.edu/abs/2024arXiv240804662S/abstract)
- [Multi-Source Attribution for Long-Form Answer Generation](https://assets.amazon.science/ed/c3/7232c163413b94ed203eb1ea46a0/towards-improved-multi-source-attribution-for-long-form-answer-generation.pdf)

### Industry
- [How Perplexity Works](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work)
- [Behind Perplexity's Architecture](https://www.frugaltesting.com/blog/behind-perplexitys-architecture-how-ai-search-handles-real-time-web-data)
- [How AI Engines Cite Sources](https://medium.com/@shuimuzhisou/how-ai-engines-cite-sources-patterns-across-chatgpt-claude-perplexity-and-sge-8c317777c71d)
- [2025 AI Visibility Report: How LLMs Choose Sources](https://thedigitalbloom.com/learn/2025-ai-citation-llm-visibility-report/)
- [AI Generated In-Text Citations — Explained](https://iaee.substack.com/p/ai-generated-in-text-citations-intuitively)

### Codebase References
- `src/integrations/thunderbolt-pro/tools.ts:46,74,81,118` — Tool descriptions and sourceLabel formatting
- `src/ai/fetch.ts:252-330` — `streamText` call with `prepareStep` and retry loop
- `src/ai/message-metadata.ts:20-74` — `sourceCollector` snapshot into stream metadata
- `src/widgets/citation/instructions.ts` — Citation widget AI instructions
- `src/components/chat/text-part.tsx` — Client-side citation rendering pipeline
- `src/ai/widget-parser.ts` — `stripBracketCitations` and widget tag parser
