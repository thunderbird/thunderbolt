import { extractReasoningMiddleware } from 'ai'

/**
 * Creates a fresh set of middleware instances.
 *
 * This is necessary because the extractReasoningMiddleware from the AI SDK
 * maintains internal state that can cause issues when reused across multiple
 * streaming operations.
 */
export const createDefaultMiddleware = (startWithReasoning: boolean = false) => [
  extractReasoningMiddleware({ tagName: 'think', startWithReasoning }),
]
