import type { LanguageModelV2Usage } from '@ai-sdk/provider'
import type { UIMessageMetadata } from '@/types'
import type { SourceMetadata } from '@/types/source'

type StreamPart = {
  type: string
  id?: string
  toolCallId?: string
  usage?: LanguageModelV2Usage
}

/**
 * Creates a messageMetadata function that tracks timing for reasoning and tool calls.
 * Start times are tracked locally; only duration is emitted on completion.
 *
 * @param modelId - The model ID to include in metadata
 * @param sourceCollector - Optional shared array populated by tool execution with source metadata
 * @returns A function that processes stream parts and returns appropriate metadata
 */
export const createMessageMetadata = (modelId: string, sourceCollector?: SourceMetadata[]) => {
  const startTimes = new Map<string, number>()
  const reasoningStack: string[] = []
  let reasoningIdCounter = 0

  const getSourcesMetadata = (): Pick<UIMessageMetadata, 'sources'> =>
    sourceCollector && sourceCollector.length > 0 ? { sources: [...sourceCollector] } : {}

  return ({ part }: { part: StreamPart }): UIMessageMetadata => {
    switch (part.type) {
      case 'finish-step':
        return { modelId, usage: part.usage, ...getSourcesMetadata() }

      case 'tool-call': {
        const id = part.toolCallId ?? part.id ?? 'unknown'
        startTimes.set(id, Date.now())
        return { modelId }
      }

      case 'reasoning-start': {
        const id = `reasoning-${reasoningIdCounter++}`
        startTimes.set(id, Date.now())
        reasoningStack.push(id)
        return { modelId }
      }

      case 'tool-result': {
        const id = part.toolCallId ?? part.id ?? 'unknown'
        const startTime = startTimes.get(id)
        const duration = startTime ? Date.now() - startTime : undefined
        return {
          ...(duration ? { reasoningTime: { [id]: duration } } : { modelId }),
          ...getSourcesMetadata(),
        }
      }

      // The AI SDK keeps the reasoning part stream open until the text part stream ends,
      // even though reasoning part content stops producing output once text part begins.
      // This means 'reasoning-end' fires late (after text completes), making it
      // unreliable for timing. We use 'text-start' to capture the actual moment
      // reasoning finishes and text generation begins.
      case 'text-start':
      case 'reasoning-end': {
        const id = reasoningStack.pop()
        if (!id) return { modelId }
        const startTime = startTimes.get(id)
        const duration = startTime ? Date.now() - startTime : undefined
        return duration ? { reasoningTime: { [id]: duration } } : { modelId }
      }

      default:
        return { modelId }
    }
  }
}
