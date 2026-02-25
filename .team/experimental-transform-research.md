# Deep Research: `experimental_transform` in AI SDK

**Date:** 2026-02-24
**AI SDK Version:** `^6.0.37`
**Related:** [Subagent Feasibility Report](.team/subagent-feasibility-report.md)

---

## What Is It?

`experimental_transform` is a parameter on `streamText()` that accepts one or more `StreamTextTransform` functions. These are `TransformStream` instances that intercept and modify the text stream **server-side, in real-time**, before it reaches `onFinish`, `onStepFinish`, or the client.

```ts
import { smoothStream, streamText } from 'ai';

streamText({
  model,
  prompt,
  experimental_transform: smoothStream({ delayInMs: 20, chunking: 'word' }),
})
```

The AI SDK ships one built-in transform: `smoothStream()`, which buffers and releases text in word/line/custom chunks with configurable delays for a natural reading experience. But you can pass **any** custom `TransformStream`, or an **array** of them.

### Type Signature (from `ai@6.0.37`)

```ts
experimental_transform?: StreamTextTransform<TOOLS> | Array<StreamTextTransform<TOOLS>>;
```

A `StreamTextTransform<TOOLS>` is a function that receives `{ tools, stopStream }` and returns a `TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>`.

---

## Current Usage in Thunderbolt

**Thunderbolt does NOT use `experimental_transform` today.**

The `streamText()` call in `src/ai/fetch.ts:252` passes no transform:

```ts
return streamText({
  temperature: modelTemperature,
  model: wrappedModel,
  system: systemPrompt,
  messages: inputMessages,
  tools: supportsTools ? (toolset as ToolSet) : undefined,
  stopWhen: stepCountIs(maxSteps),
  providerOptions,
  prepareStep: ({ steps, stepNumber, messages: stepMessages }) => { ... },
  experimental_repairToolCall: async ({ toolCall, error }) => { ... },
  // NO experimental_transform
})
```

However, the project already has **two custom stream transforms** — implemented as `LanguageModelV2Middleware` via `wrapLanguageModel()` rather than `experimental_transform`:

| Middleware | File | Purpose |
|---|---|---|
| `streaming-parser.ts` | `src/ai/middleware/streaming-parser.ts` | Parses `<think>` blocks and `<\|sentinel\|>` tags from raw model output |
| `tool-calls.ts` | `src/ai/middleware/tool-calls.ts` | Parses tool call sentinel tokens (`<\|tool_call_begin\|>` ... `<\|tool_call_end\|>`) |

Both use `wrapStream` + `TransformStream` with tag buffers to handle chunk-boundary splitting.

---

## Middleware `wrapStream` vs `experimental_transform`

These are two different interception points in the streaming pipeline:

```
Model generates tokens
  ↓
[1] Middleware wrapStream (raw LanguageModelV2StreamPart)
  ↓
AI SDK processes stream (resolves tool calls, structures parts)
  ↓
[2] experimental_transform (processed TextStreamPart<TOOLS>)
  ↓
Callbacks (onStepFinish, onFinish)
  ↓
Client (toUIMessageStream → SSE → React)
```

| Aspect | Middleware `wrapStream` | `experimental_transform` |
|---|---|---|
| **Runs at** | Raw model output level (before AI SDK processing) | After AI SDK processing (before callbacks/client) |
| **Sees** | `LanguageModelV2StreamPart` (raw provider chunks) | `TextStreamPart<TOOLS>` (processed, typed chunks) |
| **Good for** | Parsing model-specific tokens (`<think>`, `<\|tool_call\|>`) | Transforming text content (smoothing, formatting, normalization) |
| **Has access to** | Raw stream only | Tools context, `stopStream()` function |
| **Can be chained** | Via multiple middleware layers | Via array of transforms |
| **Current usage** | Yes (2 middleware in codebase) | None |

### Key Implication

Citation markers like `[1]` and widget tags like `<widget:link-preview>` appear in the **processed** stream, not in raw model tokens. This makes `experimental_transform` the natural interception point for citation format normalization — it sees the text after all model-specific parsing (think blocks, tool calls) has already been resolved.

---

## `smoothStream()` — The Built-In Transform

The AI SDK ships `smoothStream()` as the primary use case for `experimental_transform`:

```ts
import { smoothStream, streamText } from 'ai';

const result = streamText({
  model,
  prompt,
  experimental_transform: smoothStream({
    delayInMs: 20,       // default: 10ms
    chunking: 'line',    // default: 'word'
  }),
});
```

### Chunking Options

| Strategy | Value | Description |
|---|---|---|
| Word | `'word'` (default) | Stream word by word. Poor for CJK languages. |
| Line | `'line'` | Stream line by line. |
| Regex | `RegExp` | Custom regex pattern for chunk boundaries. |
| Intl.Segmenter | `Intl.Segmenter` | Locale-aware word segmentation (recommended for CJK). |
| Custom callback | `(buffer: string) => string \| undefined \| null` | Full control over chunking logic. |

### Behavior

- Buffers incoming text and reasoning chunks
- Releases content when the chunking pattern matches
- Adds configurable delays between chunks
- **Passes through non-text/reasoning chunks (tool calls, step-finish events) immediately** — no interference with the tool-calling pipeline

---

## Custom Transforms

You can write any `StreamTextTransform`. The function signature:

```ts
type StreamTextTransform<TOOLS extends ToolSet> = (options: {
  tools: TOOLS;
  stopStream: () => void;
}) => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>;
```

### Example: Citation Format Normalization

```ts
const citationNormalizationTransform = <TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> =>
  ({ tools, stopStream }) =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          controller.enqueue({
            ...chunk,
            textDelta: normalizeCitationFormat(chunk.textDelta),
          });
        } else {
          controller.enqueue(chunk);
        }
      },
    });

const normalizeCitationFormat = (text: string): string =>
  text
    .replace(/【(\d+)†[^】]*】/g, '[$1]')   // OpenAI 【2†title】 → [2]
    .replace(/【(\d+)】/g, '[$1]')            // OpenAI 【6】 → [6]
    .replace(/\[Source (\d+)\]/gi, '[$1]')    // Mistral [Source 1] → [1]
    .replace(/\(Source (\d+)\)/gi, '[$1]');   // Parenthetical → [1]
```

### Stacking Multiple Transforms

Transforms can be composed as an array — applied in order:

```ts
streamText({
  model,
  prompt,
  experimental_transform: [
    citationNormalizationTransform(),  // First: normalize citation format
    smoothStream({ delayInMs: 10 }),   // Then: smooth the output
  ],
})
```

---

## The Chunk-Splitting Problem

The main risk with stream-level text transforms is that `text-delta` chunks can split markers across boundaries:

```
chunk 1: "Fortaleza was founded in 1726. ["
chunk 2: "1]"
```

A naive regex on individual chunks would miss `[1]`. Solutions:

### Option A: Buffer with Lookahead

Hold trailing characters that could be the start of a citation marker, flush on the next chunk:

```ts
let buffer = '';

transform(chunk, controller) {
  if (chunk.type !== 'text-delta') {
    if (buffer) { controller.enqueue({ ...chunk, textDelta: buffer }); buffer = ''; }
    controller.enqueue(chunk);
    return;
  }

  buffer += chunk.textDelta;

  // Check if buffer ends with a partial citation marker
  const partialMatch = buffer.match(/\[?\d*$|【\d*†?[^】]*$/);
  if (partialMatch) {
    const safe = buffer.slice(0, partialMatch.index);
    buffer = buffer.slice(partialMatch.index!);
    if (safe) controller.enqueue({ ...chunk, textDelta: normalizeCitationFormat(safe) });
  } else {
    controller.enqueue({ ...chunk, textDelta: normalizeCitationFormat(buffer) });
    buffer = '';
  }
}
```

This is the same pattern used by `streaming-parser.ts` (`tagBuffer`) and `tool-calls.ts` (`tagBuffer`) — both hold partial tokens until the closing delimiter arrives.

### Option B: Accept Imperfect Normalization

Most citation markers arrive in a single chunk because models tend to produce `[1]` as one token. The chunk-splitting case is rare. A simpler approach: normalize what you can, rely on the existing client-side `stripBracketCitations` in `widget-parser.ts` as a fallback.

---

## Stability Status

- `experimental_transform` is **still experimental** in AI SDK 6.0.37 (the installed version)
- The AI SDK 6 migration guide has **no mention** of renaming or stabilizing it
- The `smoothStream()` docs reference it as `experimental_transform` throughout
- Type signature in `node_modules/ai/dist/index.d.mts` confirms: `experimental_transform?: StreamTextTransform<TOOLS> | Array<StreamTextTransform<TOOLS>>`
- No timeline for promotion to stable

### Risk Assessment

Low risk despite `experimental_` prefix. The API surface is simple (it's just a `TransformStream`), `smoothStream()` is widely used in production, and the parameter has been stable since AI SDK 4.1 (January 2025). If renamed, migration would be a single-line change (`experimental_transform` → `transform`).

---

## Opportunity for Thunderbolt

### What It Could Replace

A citation normalization transform at this layer could:
- Normalize `【1】` → `[1]` (GPT-OSS fullwidth brackets)
- Normalize `[Source 1]` → `[1]` (Mistral verbose format)
- Normalize `(1)` → `[1]` (parenthetical style)
- Potentially reduce some of the citation format overrides in the prompt system

### What It Cannot Do

- **Cannot inject missing citations** — if Mistral produces no `[N]` markers at all, there's nothing to transform
- **Cannot fix link preview workflow** — the multi-step fetch behavior is a tool-calling issue, not a text formatting issue
- **Cannot replace `prepareStep` nudges** — those address behavioral problems (citation omission, tool-call looping), not formatting

### Recommended Usage

```ts
// In fetch.ts, add to the streamText call:
return streamText({
  temperature: modelTemperature,
  model: wrappedModel,
  system: systemPrompt,
  messages: inputMessages,
  tools: supportsTools ? (toolset as ToolSet) : undefined,
  stopWhen: stepCountIs(maxSteps),
  providerOptions,
  experimental_transform: [
    citationNormalizationTransform(),
    // Optionally: smoothStream({ delayInMs: 10 }),
  ],
  prepareStep: ({ steps, stepNumber, messages: stepMessages }) => { ... },
  // ... rest unchanged
})
```

This would be **complementary** to the existing prompt overrides — handling format normalization at the stream level while keeping the behavioral nudges in place.

---

## Sources

- [AI SDK `streamText` Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [AI SDK `smoothStream` Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
- [AI SDK Generating Text (transform section)](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [AI SDK 4.1 Blog (introduced stream transforms)](https://vercel.com/blog/ai-sdk-4-1)
- [AI SDK 6 Blog](https://vercel.com/blog/ai-sdk-6)
- [AI SDK 6 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- [Smooth Text Streaming in AI SDK v5 (Upstash blog)](https://upstash.com/blog/smooth-streaming)
- [AI SDK v4 `smoothStream` docs](https://v4.ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
