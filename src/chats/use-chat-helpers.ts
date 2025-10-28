import { aiFetchStreamingResponse } from '@/ai/fetch'
import { trackEvent } from '@/lib/posthog'
import { useMCP } from '@/lib/mcp-provider'
import type { ChatThread, Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { type RefObject, useCallback } from 'react'
import { v7 as uuidv7 } from 'uuid'

type UseChatHelpersParams = {
  chatThread: ChatThread | null
  chatThreadId: string
  initialMessages: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
  models: Model[]
  selectedModelIdRef: RefObject<string | null>
}
export const useChatHelpers = ({
  chatThread,
  chatThreadId,
  initialMessages,
  saveMessages,
  models,
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

  const validateEncryptionState = useCallback(() => {
    const selectedModel = models.find((m) => m.id === selectedModelIdRef.current) || models[0]
    if (chatThread && chatThread.isEncrypted !== selectedModel?.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }
  }, [chatThread, models, selectedModelIdRef])

  // extend sendMessage function to add validations before sending the message
  const sendMessage: typeof chatHelpers.sendMessage = useCallback(
    async (message, options) => {
      await validateEncryptionState()

      return chatHelpers.sendMessage(message, options)
    },
    [chatHelpers, validateEncryptionState],
  )

  return { ...chatHelpers, sendMessage }
}
