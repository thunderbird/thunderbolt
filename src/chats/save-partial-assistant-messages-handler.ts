import { useThrottledCallback } from '@/hooks/use-throttle'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { type PropsWithChildren, useEffect } from 'react'
import { useChatStore } from './chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '@ai-sdk/react'
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'

type SavePartialAssistantMessagesHandlerProps = PropsWithChildren<{
  saveMessages: SaveMessagesFunction
}>

export const SavePartialAssistantMessagesHandler = ({
  children,
  saveMessages,
}: SavePartialAssistantMessagesHandlerProps) => {
  const { chatInstance, chatThreadId } = useChatStore(
    useShallow((state) => ({
      chatInstance: state.chatInstance!,
      chatThreadId: state.id!,
    })),
  )

  const { status, messages } = useChat({ chat: chatInstance })

  const isStreaming = status === 'streaming'

  useHandleIntegrationCompletion({ saveMessages })

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
