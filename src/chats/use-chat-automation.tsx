import { getTriggerPromptForThread } from '@/dal'
import type { ThunderboltUIMessage } from '@/types'
import { type UseChatHelpers } from '@ai-sdk/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

type UseChatAutomationParams = {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  chatThreadId: string
  selectedModelId: string | null
}

export const useChatAutomation = ({ chatHelpers, chatThreadId, selectedModelId }: UseChatAutomationParams) => {
  // Load the automation prompt that triggered this chat, if any
  const { data: triggerData } = useQuery({
    queryKey: ['triggerPrompt', chatThreadId],
    queryFn: () => getTriggerPromptForThread(chatThreadId),
  })

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  const hasTriggeredRef = useRef(false)

  useEffect(() => {
    if (hasTriggeredRef.current) return

    if (
      selectedModelId &&
      chatHelpers.status === 'ready' &&
      chatHelpers.messages.length > 0 &&
      chatHelpers.messages[chatHelpers.messages.length - 1].role === 'user'
    ) {
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      chatHelpers.regenerate().catch((err) => {
        hasTriggeredRef.current = false
        console.error('Auto regenerate error', err)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHelpers.status, selectedModelId])

  return { triggerData }
}
