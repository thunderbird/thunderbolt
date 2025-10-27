import { aiFetchStreamingResponse } from '@/ai/fetch'
import { trackEvent } from '@/lib/posthog'
import { useMCP } from '@/lib/mcp-provider'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { type RefObject, useCallback } from 'react'
import { v7 as uuidv7 } from 'uuid'

type UseChatHelpersParams = {
  chatThreadId: string
  initialMessages: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
  selectedModelIdRef: RefObject<string | null>
}
export const useChatHelpers = ({
  chatThreadId,
  initialMessages,
  saveMessages,
  selectedModelIdRef,
}: UseChatHelpersParams) => {
  const { getEnabledClients } = useMCP()

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
    id: chatThreadId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message }) => {
      await saveMessages({
        id: chatThreadId,
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

  return chatHelpers
}
