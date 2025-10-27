import { useThrottledCallback } from '@/hooks/use-throttle'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { type UseChatHelpers } from '@ai-sdk/react'
import { useEffect } from 'react'

type UseSavePartialAssistantMessagesParams = {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  chatThreadId: string
  saveMessages: SaveMessagesFunction
}

export const useSavePartialAssistantMessages = ({
  chatHelpers,
  chatThreadId,
  saveMessages,
}: UseSavePartialAssistantMessagesParams) => {
  const throttledSave = useThrottledCallback((message: ThunderboltUIMessage) => {
    saveMessages({
      id: chatThreadId,
      messages: [message],
    })
  }, 200)

  useEffect(() => {
    const latestMessage = chatHelpers.messages[chatHelpers.messages.length - 1]

    if (chatHelpers.status === 'streaming' && latestMessage?.role === 'assistant') {
      throttledSave(latestMessage)
    }
  }, [chatHelpers.messages, chatHelpers.status, throttledSave])
}
