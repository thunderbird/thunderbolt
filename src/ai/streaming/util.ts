import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { simulateReadableStream, streamText, wrapLanguageModel, type ToolSet, type UIMessage } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { createDefaultMiddleware } from '../middleware/default'

type SimulatedFetchOptions = {
  initialDelayInMs?: number
  chunkDelayInMs?: number
}

/**
 * Enhanced SSE file structure with front matter and multiple responses
 */
export type EnhancedSseFile = {
  metadata: Record<string, any>
  responses: string[]
}

/**
 * Parses a simple YAML front matter block
 * Note: This is a basic implementation for common use cases
 */
const parseYamlFrontMatter = (yamlContent: string): Record<string, any> => {
  const result: Record<string, any> = {}
  const lines = yamlContent.trim().split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.slice(0, colonIndex).trim()
    const valueStr = trimmedLine.slice(colonIndex + 1).trim()

    // Parse common YAML values
    let value: any = valueStr
    if (valueStr === 'true') value = true
    else if (valueStr === 'false') value = false
    else if (valueStr === 'null') value = null
    else if (/^-?\d+$/.test(valueStr)) value = parseInt(valueStr, 10)
    else if (/^-?\d*\.\d+$/.test(valueStr)) value = parseFloat(valueStr)
    else if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
      value = valueStr.slice(1, -1)
    } else if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
      value = valueStr.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

/**
 * Parses an enhanced SSE file with YAML front matter and multiple responses
 * Always returns a valid structure, never throws errors
 */
export const parseEnhancedSseFile = (fileContent: string): EnhancedSseFile => {
  const trimmedContent = fileContent.trim()

  // Handle empty content
  if (!trimmedContent) {
    return {
      metadata: {},
      responses: [''],
    }
  }

  // Check if file starts with front matter
  if (!trimmedContent.startsWith('---')) {
    // Single SSE format - treat entire content as single response with empty metadata
    return {
      metadata: {},
      responses: [trimmedContent],
    }
  }

  // Find the end of front matter
  const frontMatterEndIndex = trimmedContent.indexOf('\n---\n', 3)
  if (frontMatterEndIndex === -1) {
    // Invalid front matter format - treat as single response
    return {
      metadata: {},
      responses: [trimmedContent],
    }
  }

  // Extract and parse front matter
  const frontMatterContent = trimmedContent.slice(3, frontMatterEndIndex)
  let metadata: Record<string, any> = {}
  try {
    metadata = parseYamlFrontMatter(frontMatterContent)
  } catch {
    // If YAML parsing fails, use empty metadata
    metadata = {}
  }

  // Extract content after front matter
  const contentAfterFrontMatter = trimmedContent.slice(frontMatterEndIndex + 5).trim()

  // Split content by --- separators for multiple responses
  const responses = contentAfterFrontMatter
    .split(/\n---\n/)
    .map((response) => response.trim())
    .filter(Boolean)

  // If no responses found, use the entire content after front matter
  if (responses.length === 0) {
    return {
      metadata,
      responses: [contentAfterFrontMatter || ''],
    }
  }

  return { metadata, responses }
}

export const createSimulatedFetch = (chunks: string[], options: SimulatedFetchOptions = {}): typeof fetch => {
  const simulatedFetch: typeof fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      simulateReadableStream({
        initialDelayInMs: options.initialDelayInMs,
        chunkDelayInMs: options.chunkDelayInMs,
        chunks,
      }).pipeThrough(new TextEncoderStream()),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      },
    )
  }

  // Bun's `fetch` type expects a `preconnect` method.
  simulatedFetch.preconnect = () => Promise.resolve(false)

  return simulatedFetch
}

export const parseSseLog = (sseLog: string): string[] => {
  return sseLog
    .trim() // get rid of leading/trailing whitespace so we don't generate an empty chunk
    .split(/\n\n+/) // split **only** on the blank line that separates SSE events
    .filter(Boolean) // defensive: remove potential empty strings
    .map((chunk) => `${chunk}\n\n`) // re-append the delimiter for each chunk
}

export const createMockToolSet = (): ToolSet => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        return (...args: any[]) => {
          console.log(`[Simulated Tool] ${String(prop)}`, ...args)
          return null
        }
      },
    },
  )
}

export const sseToUIMessage = async (
  sseData: string,
  options: {
    initialDelayInMs?: number
    chunkDelayInMs?: number
    startWithReasoning?: boolean
  } = {},
): Promise<UIMessage> => {
  const chunks = parseSseLog(sseData)

  // ------------------------------------------------------------------
  // Parse the SSE stream and convert to UIMessage format
  // Use the streamText result directly to get the message content
  // ------------------------------------------------------------------

  const simulatedFetch = createSimulatedFetch(chunks, {
    initialDelayInMs: options.initialDelayInMs ?? 0,
    chunkDelayInMs: options.chunkDelayInMs ?? 0,
  })

  const provider = createOpenAICompatible({
    name: 'test-provider',
    baseURL: 'http://localhost:8000',
    fetch: simulatedFetch,
  })

  const baseModel = provider('test-model')

  const wrappedModel = wrapLanguageModel({
    model: baseModel,
    middleware: createDefaultMiddleware(options.startWithReasoning ?? false),
  })

  const result = streamText({
    model: wrappedModel,
    prompt: '<test>',
    tools: createMockToolSet(),
  })

  // Consume the stream and build UIMessage parts
  const parts: any[] = []
  let hasStepStart = false
  let currentText = ''
  let currentReasoning = ''

  // Process chunks from the stream
  for await (const chunk of result.fullStream) {
    // Check for reasoning chunks
    if (chunk.type === 'reasoning-delta') {
      const delta = (chunk as any).text || ''
      currentReasoning += delta
    } else if (chunk.type === 'reasoning-start') {
      // Start of reasoning section
      currentReasoning = ''
    } else if (chunk.type === 'reasoning-end') {
      // End of reasoning section - save it
      if (currentReasoning) {
        parts.push({ type: 'reasoning', text: currentReasoning })
        currentReasoning = ''
      }
    } else if (chunk.type === 'text-delta') {
      const text = (chunk as any).textDelta || ''
      currentText += text
    } else if (chunk.type === 'tool-call') {
      // Save any accumulated text first
      if (currentText) {
        // Check if the text contains think tags before adding
        const thinkMatch = currentText.match(/<think>([\s\S]*?)<\/think>/)
        if (thinkMatch) {
          const reasoningText = thinkMatch[1].trim()
          const remainingText = currentText.replace(/<think>[\s\S]*?<\/think>/, '').trim()

          if (reasoningText) {
            parts.push({ type: 'reasoning', text: reasoningText })
          }
          if (remainingText) {
            parts.push({ type: 'text', text: remainingText })
          }
        } else if (currentText.trim()) {
          parts.push({ type: 'text', text: currentText })
        }
        currentText = ''
      }
      // Add tool invocation
      const toolCall = chunk as any
      parts.push({
        type: 'tool-invocation',
        toolInvocation: {
          state: 'call',
          step: 0,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args || {},
        },
      })
    }
  }

  // Also check the final result
  const finalText = await result.text
  const finalToolCalls = await result.toolCalls

  // Check if we captured reasoning from the stream
  const hasStreamReasoning = parts.some((p) => p.type === 'reasoning')

  // Try to get reasoning from the result's experimental_reasoning
  const reasoning = await (result as any).experimental_reasoning
  if (reasoning && !hasStreamReasoning) {
    parts.push({ type: 'reasoning', text: reasoning })
  }

  // Add step-start if we have content
  if ((currentText || currentReasoning || finalText || finalToolCalls?.length) && !hasStepStart) {
    parts.unshift({ type: 'step-start' })
  }

  // Process any remaining accumulated reasoning
  if (currentReasoning && !hasStreamReasoning) {
    parts.push({ type: 'reasoning', text: currentReasoning })
  }

  // Process final text
  const textToProcess = currentText || finalText || ''
  if (textToProcess) {
    // Only check for think tags if we don't already have reasoning
    const hasReasoning = parts.some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      // Check if text contains reasoning pattern (think tags)
      const thinkMatch = textToProcess.match(/<think>([\s\S]*?)<\/think>/)
      if (thinkMatch) {
        const reasoningText = thinkMatch[1].trim()
        const remainingText = textToProcess.replace(/<think>[\s\S]*?<\/think>/, '').trim()

        if (reasoningText) {
          parts.push({ type: 'reasoning', text: reasoningText })
        }
        if (remainingText) {
          parts.push({ type: 'text', text: remainingText })
        }
      } else if (textToProcess.trim() && parts.filter((p) => p.type === 'text').length === 0) {
        parts.push({ type: 'text', text: textToProcess })
      }
    } else if (textToProcess.trim() && parts.filter((p) => p.type === 'text').length === 0) {
      parts.push({ type: 'text', text: textToProcess })
    }
  }

  // Add tool calls if not already added
  if (finalToolCalls && finalToolCalls.length > 0) {
    const existingToolCalls = parts.filter((p) => p.type === 'tool-invocation')
    if (existingToolCalls.length === 0) {
      for (const toolCall of finalToolCalls) {
        parts.push({
          type: 'tool-invocation',
          toolInvocation: {
            state: 'call',
            step: 0,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args: (toolCall as any).input || {},
          },
        })
      }
    }
  }

  const message: UIMessage = {
    id: `test-${uuidv7()}`,
    role: 'assistant',
    parts,
    metadata: { modelId: 'simulator' },
  }

  return message
}

/**
 * Normalizes dynamic fields in UIMessage for snapshot testing
 */
export const normalizeUIMessage = (message: any): any => {
  const normalized = JSON.parse(JSON.stringify(message))

  // Replace dynamic IDs with stable placeholders
  if (normalized.id) {
    normalized.id = '<DYNAMIC_ID>'
  }

  // Normalize tool invocation IDs
  if (normalized.parts) {
    normalized.parts = normalized.parts.map((part: any) => {
      if (part.toolInvocation?.toolCallId) {
        return {
          ...part,
          toolInvocation: {
            ...part.toolInvocation,
            toolCallId: '<DYNAMIC_TOOL_CALL_ID>',
          },
        }
      }
      return part
    })
  }

  return normalized
}

/**
 * Normalizes dynamic fields in test results for snapshot testing
 */
export const normalizeStepResult = (step: any): any => {
  const normalized = JSON.parse(JSON.stringify(step))

  // Normalize response properties
  if (normalized.response) {
    if (normalized.response.id) {
      normalized.response.id = '<DYNAMIC_ID>'
    }
    if (normalized.response.timestamp) {
      normalized.response.timestamp = '<DYNAMIC_TIMESTAMP>'
    }
  }

  return normalized
}
