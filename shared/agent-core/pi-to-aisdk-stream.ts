/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Translator: Pi {@link AgentHarness} run → AI SDK v5 UI message stream.
 *
 * This is the in-browser analogue of `src/acp/translators/acp-to-ai-sdk.ts`,
 * which does the same job for an ACP `session/update` stream. The output
 * `ReadableStream<Uint8Array>` matches what `createUIMessageStreamResponse`
 * produces — each chunk is a UTF-8 `data: <json>\n\n` line — so the app's chat
 * transport consumes it directly from a `Response.body`.
 *
 * Event mapping (Pi `AgentHarnessEvent` → AI SDK chunk):
 *   agent_start                         → start
 *   turn_start                          → start-step
 *   message_update (text_delta)         → text-start (once) → text-delta…
 *   message_update (thinking_delta)     → reasoning-start (once) → reasoning-delta…
 *   message_end                         → close any open text/reasoning part
 *   tool_execution_start                → tool-input-start + tool-input-available
 *   tool_execution_end                  → tool-output-available | tool-output-error
 *   turn_end (stopReason === 'error')   → error (carrying message.errorMessage)
 *   turn_end                            → finish-step
 *   agent_end                           → finish
 *
 * Reasoning boundaries are synthesized from deltas, not from Pi's explicit
 * `thinking_start`/`text_start` content events: reasoning opens on the first
 * `thinking_delta` and closes the moment the first `text_delta` arrives. This
 * mirrors the app's "reasoning duration ends when text begins" semantic and
 * keeps the translator robust to providers that omit the explicit boundaries.
 *
 * Durations are emitted as `message-metadata` `reasoningTime` entries keyed to
 * match `groupMessageParts`: reasoning by its 0-based ordinal (`reasoning-<n>`)
 * and tools by their `toolCallId`. The chat store deep-merges these chunks, so
 * one entry per part accumulates rather than overwrites.
 */

import type { AgentEvent, AgentHarness, AgentHarnessEvent } from '@earendil-works/pi-agent-core'

const encoder = new TextEncoder()
const now = Date.now

/** The `assistantMessageEvent` carried by a Pi `message_update` event. */
type AssistantInnerEvent = Extract<AgentEvent, { type: 'message_update' }>['assistantMessageEvent']

/**
 * Minimal AI SDK v5 UI message stream chunk shapes this translator emits. Mirrors
 * `src/acp/types.ts` (which itself mirrors `ai`'s `UIMessageChunk`), declaring
 * only the variants we produce so an upstream change surfaces as a compile error.
 * Re-declared here because `shared/` must not depend on app (`@/`) code.
 */
export type AiSdkChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string; title?: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; title?: string }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'message-metadata'; messageMetadata: Record<string, unknown> }
  | { type: 'finish-step' }
  | { type: 'finish' }
  | { type: 'error'; errorText: string }

/** Open reasoning part: its stream `id`, the `reasoningTime` key the UI expects,
 *  and the start timestamp used to compute its duration. */
type ReasoningPart = { id: string; durationKey: string; startedAt: number }

const encodeChunk = (chunk: AiSdkChunk): Uint8Array => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
const encodeDone = (): Uint8Array => encoder.encode('data: [DONE]\n\n')

/** Narrows an unknown tool-result content block to one carrying text. */
const isTextContent = (block: unknown): block is { text: string } =>
  typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'

/**
 * Derives a human error message from a Pi tool result by concatenating its text
 * content blocks, falling back to compact JSON when none are present.
 *
 * @param result - the `AgentToolResult` from a `tool_execution_end` event
 * @returns the joined error text (never empty)
 */
const toolErrorText = (result: unknown): string => {
  if (typeof result === 'object' && result !== null) {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .filter(isTextContent)
        .map((block) => block.text)
        .join('')
        .trim()
      if (text.length > 0) {
        return text
      }
    }
  }
  return JSON.stringify(result ?? {})
}

/** Stateful per-run translator. `handle` ingests harness events; `finish`
 *  guarantees a well-formed terminal sequence even when the run never reaches
 *  `agent_end` (e.g. the harness rejects before the loop starts). */
type PiTranslator = {
  /** Translate one harness event into zero or more emitted chunks. */
  handle: (event: AgentHarnessEvent) => void
  /** Close any open parts and emit the terminal `finish`. With `errorText`,
   *  an `error` chunk is emitted first. Idempotent once the stream has finished. */
  finish: (errorText?: string) => void
}

/**
 * Builds a stateful translator that writes AI SDK chunks into `emit`. Splitting
 * state from sinking lets the stream wrapper enqueue into a controller while a
 * test could collect into an array.
 *
 * @param emit - sink invoked once per produced chunk
 * @returns the translator's `handle`/`finish` surface
 */
const createPiTranslator = (emit: (chunk: AiSdkChunk) => void): PiTranslator => {
  let started = false
  let stepOpen = false
  let finished = false
  let reasoning: ReasoningPart | null = null
  let text: { id: string } | null = null
  // Run-global ordinals: part ids must be unique across the whole run, and the
  // reasoning ordinal must match `groupMessageParts`' per-message counter.
  let reasoningOrdinal = 0
  let textOrdinal = 0
  const toolStartTimes = new Map<string, number>()

  const emitDuration = (key: string, elapsedMs: number): void => {
    emit({ type: 'message-metadata', messageMetadata: { reasoningTime: { [key]: elapsedMs } } })
  }

  const closeReasoning = (): void => {
    if (!reasoning) {
      return
    }
    emit({ type: 'reasoning-end', id: reasoning.id })
    emitDuration(reasoning.durationKey, now() - reasoning.startedAt)
    reasoning = null
  }

  const closeText = (): void => {
    if (!text) {
      return
    }
    emit({ type: 'text-end', id: text.id })
    text = null
  }

  const closeOpenParts = (): void => {
    closeReasoning()
    closeText()
  }

  const ensureReasoningOpen = (): string => {
    if (reasoning) {
      return reasoning.id
    }
    // A new reasoning block means any prior text block has ended; keep parts
    // non-overlapping so the chat store assembles them cleanly.
    closeText()
    const ordinal = reasoningOrdinal++
    reasoning = { id: `pi-reasoning-${ordinal}`, durationKey: `reasoning-${ordinal}`, startedAt: now() }
    emit({ type: 'reasoning-start', id: reasoning.id })
    return reasoning.id
  }

  const ensureTextOpen = (): string => {
    if (text) {
      return text.id
    }
    text = { id: `pi-text-${textOrdinal++}` }
    emit({ type: 'text-start', id: text.id })
    return text.id
  }

  const handleInner = (inner: AssistantInnerEvent): void => {
    if (inner.type === 'thinking_delta') {
      emit({ type: 'reasoning-delta', id: ensureReasoningOpen(), delta: inner.delta })
      return
    }
    if (inner.type === 'text_delta') {
      closeReasoning()
      emit({ type: 'text-delta', id: ensureTextOpen(), delta: inner.delta })
    }
  }

  // Terminal sequence shared by `agent_end`, normal settlement, and the
  // reject/abort backstop. Guarded by `finished` so it runs exactly once.
  const finish = (errorText?: string): void => {
    if (finished) {
      return
    }
    if (!started) {
      emit({ type: 'start' })
      started = true
    }
    closeOpenParts()
    if (errorText !== undefined) {
      emit({ type: 'error', errorText })
    }
    if (stepOpen) {
      emit({ type: 'finish-step' })
      stepOpen = false
    }
    emit({ type: 'finish' })
    finished = true
  }

  const handle = (event: AgentHarnessEvent): void => {
    switch (event.type) {
      case 'agent_start': {
        if (!started) {
          emit({ type: 'start' })
          started = true
        }
        return
      }
      case 'turn_start': {
        emit({ type: 'start-step' })
        stepOpen = true
        return
      }
      case 'message_update': {
        handleInner(event.assistantMessageEvent)
        return
      }
      case 'message_end': {
        closeOpenParts()
        return
      }
      case 'tool_execution_start': {
        toolStartTimes.set(event.toolCallId, now())
        const input: unknown = event.args ?? {}
        emit({
          type: 'tool-input-start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          title: event.toolName,
        })
        emit({
          type: 'tool-input-available',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input,
          title: event.toolName,
        })
        return
      }
      case 'tool_execution_end': {
        if (event.isError) {
          emit({ type: 'tool-output-error', toolCallId: event.toolCallId, errorText: toolErrorText(event.result) })
        } else {
          emit({ type: 'tool-output-available', toolCallId: event.toolCallId, output: event.result as unknown })
        }
        const startedAt = toolStartTimes.get(event.toolCallId)
        if (startedAt !== undefined) {
          toolStartTimes.delete(event.toolCallId)
          emitDuration(event.toolCallId, now() - startedAt)
        }
        return
      }
      case 'turn_end': {
        closeOpenParts()
        const { message } = event
        if ('stopReason' in message && message.stopReason === 'error') {
          emit({ type: 'error', errorText: message.errorMessage ?? 'the request failed' })
        }
        if (stepOpen) {
          emit({ type: 'finish-step' })
          stepOpen = false
        }
        return
      }
      case 'agent_end': {
        finish()
        return
      }
      // Every other harness event (queue_update, tool_call/tool_result hooks,
      // model/tools/resources updates, etc.) is irrelevant to the UI stream.
      default:
        return
    }
  }

  return { handle, finish }
}

/**
 * Subscribes to a Pi {@link AgentHarness} run and produces the AI SDK UI message
 * stream the app's chat transport expects. The harness's own lifecycle events
 * drive every chunk; `runPrompt` only *initiates* the run (and its settlement is
 * the backstop that closes the stream), so the caller stays free to start the
 * run however it likes — a plain prompt, a skill, or a template invocation:
 *
 * ```ts
 * new Response(
 *   piHarnessToUiMessageStream(harness, async () => {
 *     await harness.prompt(text)
 *     await harness.waitForIdle()
 *   }),
 *   { headers: { 'Content-Type': 'text/event-stream' } },
 * )
 * ```
 *
 * The stream is purely streaming — chunks are enqueued as events arrive, never
 * buffered for the whole run. Cancelling the consumer (e.g. the user stops
 * generation) aborts the harness and unsubscribes.
 *
 * @param harness - the harness whose run should be streamed
 * @param runPrompt - thunk that starts the run and resolves once it settles
 * @returns a `ReadableStream` of SSE-encoded AI SDK chunks for the `Response` body
 */
export const piHarnessToUiMessageStream = (
  harness: AgentHarness,
  runPrompt: () => Promise<unknown>,
): ReadableStream<Uint8Array> => {
  let unsubscribe: (() => void) | null = null
  let closed = false

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const translator = createPiTranslator((chunk) => {
        if (!closed) {
          controller.enqueue(encodeChunk(chunk))
        }
      })
      unsubscribe = harness.subscribe((event) => translator.handle(event))

      const finalize = (errorText?: string): void => {
        if (closed) {
          return
        }
        // Unsubscribe first so no further harness event races the terminal
        // sequence, let `finish` emit its chunks while the gate is still open,
        // and only then close the gate against any straggler from `cancel`.
        unsubscribe?.()
        unsubscribe = null
        translator.finish(errorText)
        closed = true
        controller.enqueue(encodeDone())
        controller.close()
      }

      // Drive the run off this start callback. A failed turn resolves with a
      // `stopReason: 'error'` message (surfaced via `turn_end`), so a rejection
      // here is an exceptional harness failure — surface it as a terminal error.
      void (async () => {
        try {
          await runPrompt()
          finalize()
        } catch (error) {
          finalize(error instanceof Error ? error.message : String(error))
        }
      })()
    },
    async cancel() {
      closed = true
      unsubscribe?.()
      unsubscribe = null
      await harness.abort()
    },
  })
}
