import { fetch as customFetch } from '@/lib/fetch'
import { Model } from '@/types'
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamPart } from 'ai'

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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses a single Server-Sent-Event line and, if it contains JSON with a delta,
 * converts it into one or more {@link UIMessageStreamPart}s understood by the
 * Vercel AI SDK.
 */
function parseSSELine(line: string): UIMessageStreamPart[] {
  const parts: UIMessageStreamPart[] = []

  // Remove the "data:" prefix that OpenAI-compatible streams use.
  if (line.startsWith('data:')) {
    line = line.slice(5).trim()
  }

  // Ignore empty comment / heartbeat lines.
  if (!line) return parts

  // OpenAI sends a terminator line.
  if (line === '[DONE]') {
    parts.push({ type: 'finish', metadata: { finishReason: 'stop' } } as any)
    return parts
  }

  // Attempt to decode JSON – ignore malformed chunks.
  try {
    const payload = JSON.parse(line)
    const choice = payload?.choices?.[0]

    if (!choice) return parts

    const delta = choice.delta ?? {}

    // Text delta
    if (delta.content) {
      parts.push({ type: 'text', text: delta.content })
    }

    // Finish reason – emit finish part when provided
    if (choice.finish_reason) {
      parts.push({ type: 'finish', metadata: { finishReason: choice.finish_reason } } as any)
    }
  } catch {
    /* Swallow JSON parse errors silently – they happen on keep-alive lines. */
  }

  return parts
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

  console.log('model', model)

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

  // Transform the raw SSE into UIMessageStreamParts
  const stream = createUIMessageStream({
    async execute(writer) {
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
            for (const part of parsed) {
              writer.write(part)
            }
          }
        }

        // Flush any remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer)
          for (const part of parsed) {
            writer.write(part)
          }
        }
      } catch (error) {
        console.error('streamText parsing error', error)
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
      }),
  } as unknown // Cast to unknown first to bypass strict structural typing

  return result as any // The caller treats it as StreamTextResult
}
