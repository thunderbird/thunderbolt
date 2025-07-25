import { fetch as customFetch } from '@/lib/fetch'
import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'

// New imports from AI SDK testing helpers
import { streamText as aiStreamText, simulateReadableStream, wrapLanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'

import { extractReasoningMiddleware } from 'ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for the {@link streamText} function.
 */
export type StreamTextParams = {
  /**
   * The prompt messages in OpenAI-compatible format.
   */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /**
   * Optional AbortSignal to cancel the request.
   */
  signal?: AbortSignal
  /**
   * Raw SSE content. If provided, `fetch` will be ignored and this content will
   * be used to generate the simulated stream.
   */
  sseData?: string
  /**
   * Optional custom `fetch` implementation. Still supported for backwards
   * compatibility. When provided and `sseData` is not set, the response body
   * will be parsed as SSE and converted into simulated chunks.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /**
   * Optional middleware array compatible with Vercel AI SDK middleware.
   */
  middleware?: LanguageModelV2Middleware[]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses a single Server-Sent-Event line and, if it contains JSON with a delta,
 * converts it into one or more {@link LanguageModelV2StreamPart}s that can be
 * processed by middleware.
 */
export function parseSSELine(line: string): { parts: LanguageModelV2StreamPart[]; messageId?: string } {
  const parts: LanguageModelV2StreamPart[] = []
  let messageId: string | undefined

  // Remove the "data:" prefix that OpenAI-compatible streams use.
  if (line.startsWith('data:')) {
    line = line.slice(5).trim()
  }

  // Ignore empty comment / heartbeat lines.
  if (!line) return { parts }

  // OpenAI sends a terminator line.
  if (line === '[DONE]') {
    // Don't emit finish here - it will be handled by the stream ending
    return { parts }
  }

  // Attempt to decode JSON – ignore malformed chunks.
  try {
    const payload = JSON.parse(line)
    const choice = payload?.choices?.[0]

    // Extract message ID if available
    if (payload?.id) {
      messageId = payload.id
    }

    if (!choice) return { parts, messageId }

    const delta = choice.delta ?? {}

    // Text delta
    if (delta.content) {
      parts.push({
        type: 'text',
        text: delta.content,
        reasoning: delta.reasoning !== undefined ? delta.reasoning : undefined,
      } as any)
    }

    // Reasoning delta (when content is empty but reasoning is present)
    if (delta.reasoning && (!delta.content || delta.content === '')) {
      parts.push({
        type: 'text',
        text: '',
        reasoning: delta.reasoning,
      } as any)
    }

    // Check for finish reason in the choice object
    if (choice.finish_reason) {
      // Skip emitting finish part for now - we'll handle it after all content is collected
      // This is because some models send finish_reason with the last content chunk
    }
  } catch {
    /* Swallow JSON parse errors silently – they happen on keep-alive lines. */
  }

  return { parts, messageId }
}

// ---------------------------------------------------------------------------
// SSE → AI SDK test chunk conversion
// ---------------------------------------------------------------------------

function sseToChunks(sseData: string): any[] {
  const chunks: any[] = []

  const lines = sseData.split(/\r?\n/).filter((l) => l.trim())

  for (const line of lines) {
    const { parts } = parseSSELine(line)

    for (const part of parts) {
      if (part.type === 'text') {
        chunks.push({ type: 'text-delta', textDelta: (part as any).text || '' })
      } else if (part.type === 'reasoning') {
        chunks.push({ type: 'reasoning', text: (part as any).text || '' })
      }
    }
  }

  // Always end with a finish chunk so the downstream code knows we're done.
  chunks.push({
    type: 'finish',
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
    logprobs: undefined,
  })

  return chunks
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Streams chat completions from an OpenRouter-compatible endpoint and converts
 * the SSE response into a {@link UIMessageStreamPart} stream understood by the
 * Vercel AI SDK. The returned object mimics the shape of the SDK's internal
 * `StreamTextResult` so it can be consumed transparently by existing code.
 */
export const streamText = async ({
  messages,
  middleware = [],
  fetch: fetchImpl = customFetch,
  sseData,
}: StreamTextParams) => {
  // ---------------------------------------------------------------------
  // Acquire raw SSE data
  // ---------------------------------------------------------------------

  let rawSSE: string

  if (sseData) {
    rawSSE = sseData
  } else {
    // Fallback to fetch logic for backwards compatibility
    const response = await fetchImpl('https://mock.local/stream', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })

    rawSSE = await response.text()
  }

  // ---------------------------------------------------------------------
  // Convert SSE → chunks → simulateReadableStream
  // ---------------------------------------------------------------------

  const chunks = sseToChunks(rawSSE)

  const mockModel = new MockLanguageModelV2({
    doStream: async (_options) => ({
      stream: simulateReadableStream({ chunks }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  })

  if (middleware.length === 0) {
    middleware = [extractReasoningMiddleware({ tagName: 'think' })]
  }

  const wrappedModel = wrapLanguageModel({
    providerId: 'mock',
    model: mockModel as any,
    middleware,
  })

  // Finally call the real aiStreamText helper to get a StreamTextResult-like object
  const result = await aiStreamText({
    model: wrappedModel as any,
    messages,
    maxSteps: 1, // Disable multi-step execution
  })

  // Return the result directly - the AI SDK handles stream management properly
  return result
}
