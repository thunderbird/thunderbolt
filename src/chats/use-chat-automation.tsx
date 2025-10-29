import type { ThunderboltUIMessage } from '@/types'
import { type UseChatHelpers } from '@ai-sdk/react'
import { useEffect, useRef } from 'react'

type UseChatAutomationParams = {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  selectedModelId: string | null
}

export const useChatAutomation = ({ chatHelpers, selectedModelId }: UseChatAutomationParams) => {
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
}
