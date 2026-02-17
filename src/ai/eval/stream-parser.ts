import type { ParsedStream, ToolCallInfo } from './types'

/**
 * Parse the AI SDK UIMessageStream response into structured data.
 *
 * The stream uses Server-Sent Events (SSE) format where each line is:
 *   data: { "type": "...", ... }
 *
 * Key event types:
 * - text-delta: { type: "text-delta", delta: "chunk" }
 * - tool-input-available: { type: "tool-input-available", toolCallId, toolName, input }
 * - finish-step: { type: "finish-step" }
 * - finish: { type: "finish" }
 * - start-step: { type: "start-step" }
 */
export const parseStream = async (response: Response): Promise<ParsedStream> => {
  const reader = response.body?.getReader()
  if (!reader) return emptyResult('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  const textParts: string[] = []
  const toolCalls: ToolCallInfo[] = []
  let stepCount = 0
  let retryCount = 0
  let finishReason = 'unknown'

  const processLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'data: [DONE]') return

    // Strip the "data: " SSE prefix
    const jsonStr = trimmed.startsWith('data: ')
      ? trimmed.slice(6)
      : trimmed.startsWith('data:')
        ? trimmed.slice(5)
        : null
    if (!jsonStr) return

    const event = JSON.parse(jsonStr) as Record<string, unknown>

    switch (event.type) {
      case 'text-delta':
        textParts.push(event.delta as string)
        break

      case 'tool-input-available':
        toolCalls.push({
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
        })
        break

      case 'finish-step':
        stepCount++
        if (event.finishReason) finishReason = event.finishReason as string
        break

      case 'finish':
        if (event.finishReason) finishReason = event.finishReason as string
        break
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) processLine(line)
    }

    // Process any remaining data left in the buffer after the stream ends
    if (buffer.trim()) processLine(buffer)
  } catch (err) {
    return { ...emptyResult(String(err)), text: textParts.join(''), toolCalls, stepCount, retryCount }
  }

  const fullText = textParts.join('')

  // Heuristic: if steps completed but no text was produced, at least one retry was attempted
  if (stepCount > 0 && fullText.trim().length === 0) retryCount++

  return { text: fullText, toolCalls, stepCount, retryCount, finishReason }
}

const emptyResult = (error: string): ParsedStream => ({
  text: '',
  toolCalls: [],
  stepCount: 0,
  retryCount: 0,
  finishReason: 'error',
  error,
})
