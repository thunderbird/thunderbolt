import { extractReasoningMiddleware } from 'ai'
import { stripTagsMiddleware } from './strip-tags'
import { toolCallsMiddleware } from './tool-calls'

/**
 * Creates a fresh set of middleware instances.
 *
 * This is necessary because the extractReasoningMiddleware from the AI SDK
 * maintains internal state that can cause issues when reused across multiple
 * streaming operations.
 */
export const createDefaultMiddleware = () => [
  stripTagsMiddleware,
  toolCallsMiddleware,
  extractReasoningMiddleware({ tagName: 'think' }),
]
