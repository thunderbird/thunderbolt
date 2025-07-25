import { extractReasoningMiddleware } from 'ai'
import { stripTagsMiddleware } from './strip-tags'
import { toolCallsMiddleware } from './tool-calls'

export const defaultMiddleware = [
  stripTagsMiddleware,
  toolCallsMiddleware,
  extractReasoningMiddleware({ tagName: 'think' }),
]
