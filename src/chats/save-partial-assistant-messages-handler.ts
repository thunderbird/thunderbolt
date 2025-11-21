import { useThrottledCallback as useThrottledCallback_default } from '@/hooks/use-throttle'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { type PropsWithChildren, useEffect } from 'react'
import { useChatStore as useChatStore_default } from './chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat as useChat_default } from '@ai-sdk/react'

type SavePartialAssistantMessagesHandlerProps = PropsWithChildren<{
  saveMessages: SaveMessagesFunction
  useThrottledCallback?: typeof useThrottledCallback_default
  useChatStore?: typeof useChatStore_default
  useChat?: typeof useChat_default
}>

/**
 * Hook that saves partial assistant messages to the database when the chat is streaming.
 * Using dependency injection to avoid mocking modules in tests which generates a lot of noise.
 *
 * @param useThrottledCallback - The useThrottledCallback hook to use.
 * @param useChatStore - The useChatStore hook to use.
 * @param useChat - The useChat hook to use.
 */
export const SavePartialAssistantMessagesHandler = ({
  children,
  saveMessages,
  useThrottledCallback = useThrottledCallback_default,
  useChatStore = useChatStore_default,
  useChat = useChat_default,
}: SavePartialAssistantMessagesHandlerProps) => {
  const { chatInstance, chatThreadId } = useChatStore(
    useShallow((state) => ({
      chatInstance: state.chatInstance!,
      chatThreadId: state.id!,
    })),
  )

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
