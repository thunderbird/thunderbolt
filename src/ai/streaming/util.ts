import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  defaultChatStore,
  simulateReadableStream,
  streamText,
  wrapLanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai'
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
 */
export const parseEnhancedSseFile = (fileContent: string): EnhancedSseFile => {
  const trimmedContent = fileContent.trim()

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
    throw new Error('Invalid front matter format: missing closing ---')
  }

  // Extract and parse front matter
  const frontMatterContent = trimmedContent.slice(3, frontMatterEndIndex)
  const metadata = parseYamlFrontMatter(frontMatterContent)

  // Extract content after front matter
  const contentAfterFrontMatter = trimmedContent.slice(frontMatterEndIndex + 5).trim()

  // Split content by --- separators for multiple responses
  const responses = contentAfterFrontMatter
    .split(/\n---\n/)
    .map((response) => response.trim())
    .filter(Boolean)

  if (responses.length === 0) {
    throw new Error('No SSE responses found in file')
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
  // Prepare a custom fetch that mimics the real /api/chat endpoint
  // but streams from our pre-recorded SSE log. This is the same pattern
  // used by MessageSimulator (src/devtools/message-simulator.tsx).
  // ------------------------------------------------------------------

  const customFetch: typeof fetch = Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      // Build a Response that streams UI-Message chunks from the SSE log
      const simulatedFetch = createSimulatedFetch(chunks, {
        initialDelayInMs: options.initialDelayInMs,
        chunkDelayInMs: options.chunkDelayInMs,
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
        abortSignal: (init?.signal ?? undefined) as AbortSignal | undefined,
      })

      return result.toUIMessageStreamResponse({
        sendReasoning: true,
        messageMetadata: () => ({ modelId: 'simulator' }),
      })
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )

  // ------------------------------------------------------------------
  // Set up a ChatStore instance (the underlying engine behind useChat)
  // and submit a user message so that we exercise the exact same code
  // paths that the real UI uses.
  // ------------------------------------------------------------------

  const chatStore = defaultChatStore({
    api: '/api/chat',
    fetch: customFetch,
    generateId: uuidv7,
    maxSteps: 10,
  })

  const chatId = `test-${uuidv7()}`
  chatStore.addChat(chatId, [])

  // Submit a single user message (mirrors the MessageSimulator prompt)
  await chatStore.submitMessage({
    chatId,
    message: {
      role: 'user',
      parts: [{ type: 'text', text: '<test>' }],
    } as any,
  })

  // Wait for streaming to finish (status 'ready' or 'error')
  const waitForChatToFinish = async () => {
    return await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        const status = chatStore.getStatus(chatId)
        if (status === 'ready') {
          clearInterval(interval)
          resolve()
        } else if (status === 'error') {
          clearInterval(interval)
          reject(chatStore.getError(chatId))
        }
      }, 10)
    })
  }

  await waitForChatToFinish()

  // Collect the assistant's final message
  const messages = chatStore.getMessages(chatId)
  const actualMessage = messages.filter((m: any) => m.role === 'assistant').pop()

  if (!actualMessage) {
    throw new Error('Failed to convert SSE data into UIMessage.')
  }

  return actualMessage
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
