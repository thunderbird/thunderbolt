import type { ThunderboltUIMessage } from '@/types'
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai'

/**
 * Remove the most recent assistant message (and any messages that follow it)
 * whenever that assistant message still has unfinished tool calls (state !== 'output-available').
 *
 * This prevents `convertToModelMessages` from throwing `Unsupported tool part state: input-available`.
 */
export const filterIncompleteAssistantMessage = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] => {
  // Walk backwards to locate the most-recent assistant message without allocating
  let assistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantIdx = i
      break
    }
  }

  if (assistantIdx === -1) return messages // no assistant message found

  const assistantMessage = messages[assistantIdx]

  // Evaluate completeness on that single message only – cheaper than scanning full history
  const isComplete = lastAssistantMessageIsCompleteWithToolCalls({ messages: [assistantMessage] })

  return isComplete ? messages : messages.slice(0, assistantIdx)
}
