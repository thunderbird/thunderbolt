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
function parseSSELine(line: string): {
  textContent?: string
  isFinished?: boolean
  finishReason?: string
  id?: string
} {
  // Remove the "data:" prefix that OpenAI-compatible streams use.
  if (line.startsWith('data:')) {
    line = line.slice(5).trim()
  }

  // Ignore empty comment / heartbeat lines.
  if (!line) return {}

  // OpenAI sends a terminator line.
  if (line === '[DONE]') {
    return { isFinished: true, finishReason: 'stop' }
  }

  // Attempt to decode JSON – ignore malformed chunks.
  try {
    const payload = JSON.parse(line)
    const choice = payload?.choices?.[0]

    if (!choice) return {}

    const delta = choice.delta ?? {}
    const result: { textContent?: string; isFinished?: boolean; finishReason?: string; id?: string } = {}

    // Extract ID from the payload
    if (payload.id) {
      result.id = payload.id
    }

    // Text delta
    if (delta.content) {
      result.textContent = delta.content
    }

    // Finish reason – emit finish part when provided
    if (choice.finish_reason) {
      result.isFinished = true
      result.finishReason = choice.finish_reason
    }

    return result
  } catch {
    /* Swallow JSON parse errors silently – they happen on keep-alive lines. */
    return {}
  }
}

/**
 * Parses content with <think> tags and returns appropriate message parts
 */
function parseContentIntoParts(
  allTextContent: string,
  messageId?: string,
): { parts: UIMessageStreamPart[]; id: string } {
  const parts: UIMessageStreamPart[] = []

  // Parse reasoning content from <think> tags
  const thinkMatch = allTextContent.match(/<think>([\s\S]*?)<\/think>/)
  if (thinkMatch) {
    const reasoningContent = thinkMatch[1].trim()
    if (reasoningContent) {
      parts.push({
        type: 'reasoning',
        text: reasoningContent,
      } as any)
    }
  }

  // Extract text content (everything after </think> tag, or all content if no think tags)
  let textContent = allTextContent
  if (thinkMatch) {
    const afterThinkIndex = allTextContent.indexOf('</think>') + '</think>'.length
    textContent = allTextContent.substring(afterThinkIndex).trim()
  }

  if (textContent) {
    parts.push({
      type: 'text',
      text: textContent,
    } as any)
  }

  return {
    parts,
    id: messageId || `fallback_${Date.now()}`,
  }
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
      let allTextContent = '' // Buffer for all text content
      let messageId: string | undefined // Capture the message ID

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

            // Capture the message ID from the first line that has one
            if (parsed.id && !messageId) {
              messageId = parsed.id
            }

            // Buffer text content as it comes in
            if (parsed.textContent) {
              allTextContent += parsed.textContent
            }

            // When finished, parse the full content and emit proper parts
            if (parsed.isFinished) {
              const { parts, id } = parseContentIntoParts(allTextContent, messageId)
              for (const part of parts) {
                writer.write(part)
              }
              writer.write({
                type: 'finish',
                metadata: { finishReason: parsed.finishReason || 'stop', messageId: id },
              } as any)
              return // Exit early when finished
            }
          }
        }

        // Flush any remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer)
          if (parsed.id && !messageId) {
            messageId = parsed.id
          }
          if (parsed.textContent) {
            allTextContent += parsed.textContent
          }
          if (parsed.isFinished) {
            const { parts, id } = parseContentIntoParts(allTextContent, messageId)
            for (const part of parts) {
              writer.write(part)
            }
            writer.write({
              type: 'finish',
              metadata: { finishReason: parsed.finishReason || 'stop', messageId: id },
            } as any)
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
