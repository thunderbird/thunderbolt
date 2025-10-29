import { useThrottledCallback } from '@/hooks/use-throttle'
import type { ThunderboltUIMessage } from '@/types'
import { useEffect } from 'react'
import { useChatData } from './chat-data-provider'

type UseSavePartialAssistantMessagesParams = {
  isStreaming: boolean
  messages: ThunderboltUIMessage[]
}

export const useSavePartialAssistantMessages = ({ isStreaming, messages }: UseSavePartialAssistantMessagesParams) => {
  const { id: chatThreadId, saveMessages } = useChatData()

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
}
