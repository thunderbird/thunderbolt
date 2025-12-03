import { useEffect, useRef } from 'react'
import { useChatStore } from './chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat as useChat_default } from '@ai-sdk/react'

type UseChatAutomationProps = {
  chatId: string
  useChat?: typeof useChat_default
}

export const useChatAutomation = ({ chatId, useChat = useChat_default }: UseChatAutomationProps) => {
  const { chatInstance } = useChatStore(
    useShallow((state) => {
      const chatItem = state.chats.get(chatId)!

      return {
        chatInstance: chatItem.chatInstance,
      }
    }),
  )

  const { messages } = useChat({ chat: chatInstance })

  const hasMessages = messages.length

  const hasTriggeredRef = useRef(false)

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    if (
      !hasTriggeredRef.current &&
      chatInstance?.status === 'ready' &&
      hasMessages &&
      chatInstance?.messages[chatInstance?.messages.length - 1].role === 'user'
    ) {
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      chatInstance?.regenerate().catch((err) => {
        console.error('Auto regenerate error', err)
      })
    }
  }, [chatInstance, hasMessages])
}
