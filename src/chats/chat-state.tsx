import { aiFetchStreamingResponse } from '@/ai/fetch'
import ChatUI from '@/components/chat/chat-ui'
import { useThrottledCallback } from '@/hooks/use-throttle'
import { trackEvent } from '@/lib/posthog'
import { useMCP } from '@/lib/mcp-provider'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useChat, type UseChatHelpers } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useCallback, useEffect } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { useChatModel } from './use-chat-model'
import { useChatAutomation } from './use-chat-automation'

interface ChatStateProps {
  id: string
  initialMessages?: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
}

type UseSavePartialAssistantMessages = {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  id: string
  saveMessages: SaveMessagesFunction
}

const useSavePartialAssistantMessages = ({ chatHelpers, id, saveMessages }: UseSavePartialAssistantMessages) => {
  const throttledSave = useThrottledCallback((message: ThunderboltUIMessage) => {
    saveMessages({
      id,
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

export default function ChatState({ id, initialMessages, saveMessages }: ChatStateProps) {
  const { getEnabledClients } = useMCP()

  const { handleModelChange, models, selectedModelId, selectedModelIdRef } = useChatModel(id)

  // Stable fetch function that always reads the latest model id from the ref
  const customFetch = useCallback(
    Object.assign(
      async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
        if (!init) throw new Error('Missing init')

        const modelId = selectedModelIdRef.current
        if (!modelId) throw new Error('No model selected')

        return aiFetchStreamingResponse({
          init,
          saveMessages,
          modelId,
          mcpClients: getEnabledClients(),
        })
      },
      {
        preconnect: () => Promise.resolve(false),
      },
    ),
    [getEnabledClients, saveMessages],
  )

  const chatHelpers = useChat<ThunderboltUIMessage>({
    id,
    messages: initialMessages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message }) => {
      await saveMessages({
        id,
        messages: [message],
      })

      trackEvent('chat_receive_reply', {
        model: selectedModelIdRef.current,
        length: message.parts?.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0) || 0,
        reply_number: chatHelpers.messages.length + 1,
      })
    },
    onError: (error) => {
      console.error('Chat error:', error)
      // The error will be available in chatHelpers.error for the UI to display
    },
  })

  useSavePartialAssistantMessages({ chatHelpers, id, saveMessages })

  const { triggerData } = useChatAutomation({ chatHelpers, chatThreadId: id, selectedModelId })

  // If we don't pass a selectedModelId to the ChatUI, it will warn about changing an input from uncontrolled to controlled
  if (!selectedModelId) {
    return null
  }

  return (
    <ChatUI
      chatHelpers={chatHelpers}
      models={models}
      selectedModelId={selectedModelId ?? undefined}
      onModelChange={handleModelChange}
      triggerAutomation={triggerData ?? undefined}
      chatThreadId={id}
    />
  )
}
