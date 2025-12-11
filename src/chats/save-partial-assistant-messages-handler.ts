import { useThrottledCallback } from '@/hooks/use-throttle'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { type PropsWithChildren, useEffect } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'

type SavePartialAssistantMessagesHandlerProps = PropsWithChildren<{
  saveMessages: SaveMessagesFunction
  useChat?: typeof useChat_default
}>

/**
 * Hook that saves partial assistant messages to the database when the chat is streaming.
 * Using dependency injection to avoid mocking modules in tests which generates a lot of noise.
 */
export const SavePartialAssistantMessagesHandler = ({
  children,
  saveMessages,
  useChat = useChat_default,
}: SavePartialAssistantMessagesHandlerProps) => {
  const { chatInstance, id: chatThreadId } = useCurrentChatSession()

  const { status, messages } = useChat({ chat: chatInstance })

  const isStreaming = status === 'streaming'

  const throttledSave = useThrottledCallback((message: ThunderboltUIMessage) => {
    saveMessages({
      id: chatThreadId,
      messages: [message],
    })
  }, 200)

  useEffect(() => {
    const latestMessage = messages[messages.length - 1]

    if (isStreaming && latestMessage?.role === 'assistant') {
      throttledSave(latestMessage)
    }
  }, [messages, isStreaming, throttledSave])

  return children
}
