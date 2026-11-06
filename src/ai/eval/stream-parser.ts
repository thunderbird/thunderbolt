/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { ParsedStream, ToolCallInfo } from './types'

const transportCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])
const providerErrorNames = new Set([
  'AI_APICallError',
  'AI_EmptyResponseBodyError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'NetworkError',
  'TimeoutError',
  'HttpError',
])

const recognizedException = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }
  if ('name' in error && providerErrorNames.has(String(error.name))) {
    return true
  }
  if ('code' in error && transportCodes.has(String(error.code))) {
    return true
  }
  const status = 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    return true
  }
  return 'cause' in error && error.cause !== error ? recognizedException(error.cause) : false
}

/** Preserve only the admission header from SDK errors, including wrapped transport errors. */
const readHttpErrorMetadata = (error: unknown): Pick<ParsedStream, 'retryAfter' | 'httpStatus'> => {
  if (!error || typeof error !== 'object') {
    return {}
  }
  const headers = 'responseHeaders' in error ? error.responseHeaders : 'headers' in error ? error.headers : undefined
  const value =
    headers instanceof Headers
      ? headers.get('retry-after')
      : headers && typeof headers === 'object'
        ? Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
        : undefined
  const status = 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined
  return {
    ...('cause' in error && error.cause !== error ? readHttpErrorMetadata(error.cause) : {}),
    ...(typeof value === 'string' ? { retryAfter: value } : {}),
    ...(typeof status === 'number' ? { httpStatus: status } : {}),
  }
}

/** Preserve unknown adapter exceptions as non-retryable error trials, rather than guessing infrastructure. */
export const describeExecutionError = (
  error: unknown,
): Pick<ParsedStream, 'error' | 'errorStack' | 'unclassified' | 'retryAfter' | 'httpStatus'> => ({
  error: error instanceof Error ? error.message : String(error),
  errorStack: error instanceof Error ? error.stack : undefined,
  ...readHttpErrorMetadata(error),
  unclassified: !recognizedException(error),
})

/**
 * Reconstruct an assistant message's parts from a parsed stream: each completed
 * tool call (those whose output arrived) as a `dynamic-tool` part, then the
 * final text. Used to feed prior-turn tool results back into history for
 * multi-turn scenarios.
 *
 * When tools ran before the final text, a `step-start` boundary is inserted
 * between them so `convertToModelMessages` replays production order —
 * assistant(tool-call) → tool(result) → assistant(text) — instead of folding
 * the answer into the tool-call assistant message ahead of its results.
 */
export const buildAssistantParts = (
  text: string,
  toolCalls: ToolCallInfo[],
  toolOutputs: Map<string, unknown>,
  toolErrors = new Map<string, string>(),
): ThunderboltUIMessage['parts'] => {
  const toolParts: ThunderboltUIMessage['parts'] = toolCalls
    .filter((call) => toolOutputs.has(call.toolCallId) || toolErrors.has(call.toolCallId))
    .map((call) => ({
      type: 'dynamic-tool',
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      ...(toolErrors.has(call.toolCallId)
        ? { state: 'output-error' as const, errorText: toolErrors.get(call.toolCallId)! }
        : { state: 'output-available' as const, output: toolOutputs.get(call.toolCallId) }),
    }))
  if (text.trim().length === 0) {
    return toolParts
  }
  const textPart = { type: 'text', text } as const
  return toolParts.length > 0 ? [...toolParts, { type: 'step-start' }, textPart] : [textPart]
}

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
export const parseStream = async (
  response: Response,
  signal?: AbortSignal,
  onProgress?: (parsed: ParsedStream) => void,
): Promise<ParsedStream> => {
  const reader = response.body?.getReader()
  if (!reader) {
    return { ...emptyResult('No response body'), ...readHttpErrorMetadata(response) }
  }
  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  if (signal?.aborted) {
    await reader.cancel(signal.reason)
    throw signal.reason
  }
  signal?.addEventListener('abort', cancelOnAbort, { once: true })

  const decoder = new TextDecoder()
  let buffer = ''
  const textParts: string[] = []
  const toolCalls: ToolCallInfo[] = []
  const toolOutputs = new Map<string, unknown>()
  const toolErrors = new Map<string, string>()
  const events: Record<string, unknown>[] = []
  const errors: string[] = []
  let stepCount = 0
  let retryCount = 0
  let finishReason = 'unknown'
  let retryAfter = response.headers.get('retry-after') ?? undefined
  let httpStatus = response.status

  const snapshot = (): ParsedStream => ({
    text: textParts.join(''),
    toolCalls,
    assistantParts: buildAssistantParts(textParts.join(''), toolCalls, toolOutputs, toolErrors),
    stepCount,
    retryCount,
    finishReason,
    events,
    retryAfter,
    httpStatus,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  })

  const processLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'data: [DONE]') {
      return
    }

    // Strip the "data: " SSE prefix
    const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5) : null
    if (!jsonStr) {
      return
    }

    const event = JSON.parse(jsonStr) as Record<string, unknown>

    events.push(event)
    switch (event.type) {
      case 'text-delta':
        textParts.push(event.delta as string)
        break

      case 'tool-input-available':
        toolCalls.push({
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          input: event.input,
        })
        break

      case 'tool-output-available':
        toolOutputs.set(event.toolCallId as string, event.output)
        break

      case 'error': {
        const metadata = readHttpErrorMetadata(event)
        retryAfter = metadata.retryAfter ?? (typeof event.retryAfter === 'string' ? event.retryAfter : retryAfter)
        httpStatus = metadata.httpStatus ?? httpStatus
        errors.push(String(event.errorText ?? event.error ?? 'SSE error'))
        break
      }

      case 'tool-output-error':
        toolErrors.set(event.toolCallId as string, String(event.errorText))
        break

      case 'finish-step':
        stepCount++
        if (event.finishReason) {
          finishReason = event.finishReason as string
        }
        break

      case 'finish':
        if (event.finishReason) {
          finishReason = event.finishReason as string
        }
        break
    }
    onProgress?.(snapshot())
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        processLine(line)
      }
    }

    // Process any remaining data left in the buffer after the stream ends
    if (buffer.trim()) {
      processLine(buffer)
    }
  } catch (err) {
    const exception = describeExecutionError(err)
    const unclassified = errors.length === 0 && exception.unclassified
    errors.push(String(err))
    return {
      ...snapshot(),
      httpStatus: exception.httpStatus ?? httpStatus,
      retryAfter: exception.retryAfter ?? retryAfter,
      errorStack: exception.errorStack,
      unclassified,
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort)
  }

  const fullText = textParts.join('')

  // Heuristic: if steps completed but no text was produced, at least one retry was attempted
  if (stepCount > 0 && fullText.trim().length === 0) {
    retryCount++
  }

  if (signal?.aborted) {
    errors.push(String(signal.reason))
  }
  return snapshot()
}

const emptyResult = (error: string): ParsedStream => ({
  text: '',
  toolCalls: [],
  assistantParts: [],
  stepCount: 0,
  retryCount: 0,
  finishReason: 'error',
  error,
})
