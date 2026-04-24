import { useEffect, useRef } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useAcpChatActions } from './use-acp-chat'
import type { SaveMessagesFunction } from '@/types'

type UseChatAutomationProps = {
  saveMessages?: SaveMessagesFunction
}

export const useChatAutomation = ({ saveMessages }: UseChatAutomationProps = {}) => {
  const { messages, status } = useCurrentChatSession()

  const hasMessages = messages.length

  const { regenerate } = useAcpChatActions(saveMessages)

  const hasTriggeredRef = useRef(false)

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    if (
      !hasTriggeredRef.current &&
      status === 'ready' &&
      hasMessages &&
      messages[messages.length - 1].role === 'user'
    ) {
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      regenerate().catch((err) => {
        console.error('Auto regenerate error', err)
      })
    }
  }, [status, hasMessages, messages, regenerate])
}
