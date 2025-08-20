import { hermesToolMiddleware } from '@ai-sdk-tool/parser'
import { extractReasoningMiddleware } from 'ai'
import { textBoundaryMiddleware } from './text-boundary'

/**
 * Creates a fresh set of middleware instances.
 *
 * This is necessary because the extractReasoningMiddleware from the AI SDK
 * maintains internal state that can cause issues when reused across multiple
 * streaming operations.
 */
export const createDefaultMiddleware = (startWithReasoning: boolean = false) => [
  extractReasoningMiddleware({ tagName: 'think', startWithReasoning }),
  textBoundaryMiddleware,
]

/**
 * Creates middleware specifically for the Flower provider with enhanced tool support.
 * The Flower provider benefits from the Qwen/Hermes tool middleware which enables
 * function calling capabilities for models that don't natively support OpenAI-style tools.
 */
export const createFlowerMiddleware = (startWithReasoning: boolean = false) => [
  extractReasoningMiddleware({ tagName: 'think', startWithReasoning }),
  hermesToolMiddleware,
]
