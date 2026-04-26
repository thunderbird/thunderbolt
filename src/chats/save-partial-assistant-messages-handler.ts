import { useThrottledCallback } from '@/hooks/use-throttle'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { type PropsWithChildren, useEffect } from 'react'
import { useCurrentChatSession } from './chat-store'

type SavePartialAssistantMessagesHandlerProps = PropsWithChildren<{
  saveMessages: SaveMessagesFunction
}>

/**
 * Hook that saves partial assistant messages to the database when the chat is streaming.
 */
export const SavePartialAssistantMessagesHandler = ({
  children,
  saveMessages,
}: SavePartialAssistantMessagesHandlerProps) => {
  const { id: chatThreadId, status, messages } = useCurrentChatSession()

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
