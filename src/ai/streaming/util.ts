/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  extractReasoningMiddleware,
  readUIMessageStream,
  simulateReadableStream,
  streamText,
  wrapLanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai'

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
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const key = trimmedLine.slice(0, colonIndex).trim()
    const valueStr = trimmedLine.slice(colonIndex + 1).trim()

    // Parse common YAML values
    let value: any = valueStr
    if (valueStr === 'true') {
      value = true
    } else if (valueStr === 'false') {
      value = false
    } else if (valueStr === 'null') {
      value = null
    } else if (/^-?\d+$/.test(valueStr)) {
      value = parseInt(valueStr, 10)
    } else if (/^-?\d*\.\d+$/.test(valueStr)) {
      value = parseFloat(valueStr)
    } else if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
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
  let metadata: Record<string, any>
  try {
    metadata = parseYamlFrontMatter(frontMatterContent)
  } catch {
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
          console.log('[Simulated Tool] %s', String(prop), ...args)
          return null
        }
      },
    },
  )
}

/**
 * Creates a stream for converting SSE data to UIMessage format.
 * Returns the result object that can be consumed with proper timer advancement.
 */
const createSseToUIMessageStream = (
  sseData: string,
  options: {
    initialDelayInMs?: number
    chunkDelayInMs?: number
    startWithReasoning?: boolean
  } = {},
) => {
  const chunks = parseSseLog(sseData)

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
    middleware: [
      extractReasoningMiddleware({
        tagName: 'think',
        startWithReasoning: options.startWithReasoning ?? false,
      }),
    ],
  })

  const result = streamText({
    model: wrappedModel,
    prompt: '<test>',
    tools: createMockToolSet(),
    _internal: {
      generateId: () => '<DYNAMIC_ID>',
    },
  })

  const uiStream = result.toUIMessageStream({
    sendReasoning: true,
    messageMetadata: () => ({ modelId: 'simulator' }),
  })

  return readUIMessageStream({ stream: uiStream })
}

export const sseToUIMessage = async (
  sseData: string,
  options: {
    initialDelayInMs?: number
    chunkDelayInMs?: number
    startWithReasoning?: boolean
    advanceTimers?: () => Promise<void>
  } = {},
): Promise<UIMessage> => {
  const messageIterator = createSseToUIMessageStream(sseData, options)

  // Start consuming the stream
  const consumePromise = (async () => {
    let finalMessage: UIMessage | undefined
    for await (const msg of messageIterator) {
      finalMessage = msg
    }
    if (!finalMessage) {
      throw new Error('No UIMessage produced from SSE log')
    }
    return finalMessage
  })()

  // If timer advancement is provided, run it alongside stream consumption
  if (options.advanceTimers) {
    await options.advanceTimers()
  }

  return consumePromise
}

/**
 * Recursively normalizes common dynamic fields for snapshot testing
 */
const normalizeDynamicFields = (obj: any): any => {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(normalizeDynamicFields)
  }

  const normalized = { ...obj }

  // Normalize IDs
  if (typeof normalized.id === 'string') {
    normalized.id = '<DYNAMIC_ID>'
  }
  if (typeof normalized.toolCallId === 'string') {
    normalized.toolCallId = '<DYNAMIC_ID>'
  }

  // Normalize timestamps
  if (normalized.timestamp) {
    normalized.timestamp = '<DYNAMIC_TIMESTAMP>'
  }

  // Recursively normalize nested objects
  for (const key in normalized) {
    if (typeof normalized[key] === 'object' && normalized[key] !== null) {
      normalized[key] = normalizeDynamicFields(normalized[key])
    }
  }

  return normalized
}

/**
 * Normalizes dynamic fields in UIMessage for snapshot testing
 */
export const normalizeUIMessage = (message: any): any => {
  return normalizeDynamicFields(JSON.parse(JSON.stringify(message)))
}

/**
 * Normalizes dynamic fields in test results for snapshot testing
 */
export const normalizeStepResult = (step: any): any => {
  return normalizeDynamicFields(JSON.parse(JSON.stringify(step)))
}
