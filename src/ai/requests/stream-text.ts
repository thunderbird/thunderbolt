import { fetch as customFetch } from '@/lib/fetch'
import { Model } from '@/types'
import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamPart, wrapLanguageModel } from 'ai'
import { streamingParserMiddleware } from '@/ai/middleware/streaming-parser-debug'
import { reasoningPropertyParserMiddleware } from '@/ai/middleware/reasoning-property-parser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for the {@link streamText} function.
 */
export type StreamTextParams = {
  /**
   * The model configuration selected by the user.
   */
  model: Model
  /**
   * The prompt messages in OpenAI-compatible format.
   */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /**
   * Optional AbortSignal to cancel the request.
   */
  signal?: AbortSignal
  /**
   * Temperature used for the generation (defaults to `0.25`).
   */
  temperature?: number
  /**
   * Base URL of an OpenAI-compatible endpoint (must include the `/v1` suffix).
   * Defaults to the public OpenRouter endpoint.
   *
   * Example: `https://openrouter.ai/api/v1` or `https://example.com/v1`.
   */
  baseUrl?: string
  /**
   * Optional custom `fetch` implementation. Useful for testing to inject a mock
   * without relying on module mocking.
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
        reasoning: delta.reasoning !== undefined ? delta.reasoning : undefined
      } as any)
    }

    // Reasoning delta (when content is empty but reasoning is present)
    if (delta.reasoning && (!delta.content || delta.content === '')) {
      parts.push({ 
        type: 'text', 
        text: '', 
        reasoning: delta.reasoning 
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

/**
 * Converts a {@link LanguageModelV2StreamPart} to a {@link UIMessageStreamPart}
 * for compatibility with the UI message stream.
 */
function convertToUIMessageStreamPart(part: LanguageModelV2StreamPart): UIMessageStreamPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: (part as any).text }
    case 'reasoning':
      return { type: 'reasoning', text: (part as any).text }
    case 'finish':
      return {
        type: 'finish',
        finishReason: (part as any).finishReason || 'stop',
        usage: (part as any).usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      } as any
    case 'error':
      return { type: 'error', errorText: (part as any).error?.message || 'Unknown error' }
    default:
      // Skip unknown part types
      return null
  }
}

/**
 * Creates a minimal language model that can be wrapped with middleware.
 * This allows us to use the existing middleware infrastructure from the AI SDK.
 */
function createSSELanguageModel(response: Response): any {
  let messageId = 'unknown'

  const doStream = async () => {
    // Create a stream that parses SSE into LanguageModelV2StreamParts
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''

        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // SSE events are separated by newlines – process complete lines only
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? '' // Keep the incomplete remainder

            for (const line of lines) {
              const parsed = parseSSELine(line)
              
              // Capture messageId from first SSE event that has one
              if (parsed.messageId && messageId === 'unknown') {
                messageId = parsed.messageId
              }
              
              for (const part of parsed.parts) {
                controller.enqueue(part)
              }
            }
          }

          // Flush any remaining buffer
          if (buffer.trim()) {
            const parsed = parseSSELine(buffer)
            for (const part of parsed.parts) {
              controller.enqueue(part)
            }
          }

          // Always emit a finish event when the stream ends with messageId
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            messageId,
          } as any)
        } catch (error) {
          console.error('streamText parsing error', error)
          controller.enqueue({ type: 'error', error: { message: (error as Error).message } } as any)
        } finally {
          controller.close()
        }
      },
    })

    return {
      stream,
      warnings: undefined,
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      experimental_providerMetadata: undefined,
      messageId,
    }
  }

  // Return a minimal language model compatible with wrapLanguageModel
  return {
    specificationVersion: 'v2',
    provider: 'openrouter-sse',
    modelId: 'openrouter-stream',
    doStream,
    doGenerate: async () => {
      throw new Error('Generation not supported in SSE stream mode')
    },
    getMessageId: () => messageId,
  } as any
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
  model,
  messages,
  signal,
  temperature = 0.25,
  baseUrl = 'https://openrouter.ai/api/v1',
  fetch: fetchImpl = customFetch,
  middleware = [],
}: StreamTextParams) => {
  const url = `${baseUrl}/chat/completions`

  // Build the request payload
  const body = {
    model: model.model,
    messages,
    stream: true,
    temperature,
    tool_choice: 'auto',
  }

  // Prepare headers – include Authorization if available
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${model.apiKey}`,
  }
  if (model.apiKey) {
    headers['Authorization'] = `Bearer ${model.apiKey}`
  }

  // Fire the request
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`)
  }

  // Apply middleware to process the stream
  const baseModel = createSSELanguageModel(response)

  if (middleware.length === 0) {
    // Apply default middleware - try both think tag parsing and reasoning property parsing
    middleware = [streamingParserMiddleware, reasoningPropertyParserMiddleware]
  }
  
  // Apply middleware using wrapLanguageModel
  const wrappedModel = wrapLanguageModel({
    providerId: 'openrouter-sse',
    model: baseModel,
    middleware,
  })

  // Use the wrapped model to create the stream
  const streamResult = await (wrappedModel as any).doStream()

  // Convert the processed stream to UIMessageStreamParts
  const stream = createUIMessageStream({
      async execute(writer) {
        const reader = streamResult.stream.getReader()
        let messageId = (baseModel as any).getMessageId?.() || 'unknown'

        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            // Extract messageId from finish parts if available
            if ((value as any).type === 'finish' && (value as any).messageId) {
              messageId = (value as any).messageId
            }

            const uiPart = convertToUIMessageStreamPart(value)
            if (uiPart) {
              // Add messageId to finish parts
              if (uiPart.type === 'finish') {
                (uiPart as any).metadata = { finishReason: 'stop', messageId }
              }
              writer.write(uiPart)
            }
          }
        } catch (error) {
          console.error('streamText middleware processing error', error)
          writer.write({ type: 'error', errorText: (error as Error).message })
        }
      },
    })

  // Minimal StreamTextResult implementation compatible with .toUIMessageStreamResponse()
  const result = {
    stream,
    toUIMessageStreamResponse: (
      options: { status?: number; headers?: Record<string, string>; [key: string]: any } = {},
    ) =>
      createUIMessageStreamResponse({
        status: options.status ?? 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...(options.headers ?? {}),
        },
        stream,
        ...options,
      }),
  } as unknown // Cast to unknown first to bypass strict structural typing

  return result as any // The caller treats it as StreamTextResult
}
