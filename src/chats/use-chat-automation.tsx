import { useEffect } from 'react'
import { useChatStore } from './chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '@ai-sdk/react'

export const useChatAutomation = () => {
  const { chatInstance } = useChatStore(
    useShallow((state) => ({
      chatInstance: state.chatInstance!,
    })),
  )

  const { messages } = useChat({ chat: chatInstance })

  const hasMessages = messages.length

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    if (
      chatInstance?.status === 'ready' &&
      hasMessages &&
      chatInstance?.messages[chatInstance?.messages.length - 1].role === 'user'
    ) {
      // Regenerate assistant response for the last user message
      chatInstance?.regenerate().catch((err) => {
        console.error('Auto regenerate error', err)
      })
    }
  }, [chatInstance, chatInstance?.status, hasMessages])
}
