import { aiFetchStreamingResponse } from '@/ai/fetch'
import { trackEvent } from '@/lib/posthog'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { useChatStore } from './chat-store'

export const createChatInstance = (
  id: string,
  messages: ThunderboltUIMessage[],
  saveMessages: SaveMessagesFunction,
) => {
  const customFetch = Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      if (!init) throw new Error('Missing init')

      const { mcpClients, sessions } = useChatStore.getState()

      const session = sessions.get(id)

      if (!session) throw new Error('No session found')

      return aiFetchStreamingResponse({
        init,
        saveMessages,
        modelId: session.selectedModel.id,
        modeSystemPrompt: session.selectedMode.systemPrompt ?? undefined,
        mcpClients,
      })
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )

  const instance = new Chat<ThunderboltUIMessage>({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message }) => {
      const { sessions } = useChatStore.getState()

      const session = sessions.get(id)

      if (!session) throw new Error('No session found')

      await saveMessages({ id, messages: [message] })

      trackEvent('chat_receive_reply', {
        model: session.selectedModel,
        length: message.parts?.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0) || 0,
        reply_number: instance.messages.length + 1,
      })
    },
    onError: (error) => {
      console.error('Chat error:', error)
      // The error will be available in chatHelpers.error for the UI to display
    },
  })

  const originalSendMessage = instance.sendMessage.bind(instance)

  // Override the sendMessage method to check if the model is available for the chat thread
  instance.sendMessage = async function (message, options) {
    const { sessions } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) throw new Error('No session found')

    const { chatThread, selectedModel } = session

    if (!selectedModel) {
      throw new Error('No selected model')
    }

    if (chatThread && chatThread.isEncrypted !== selectedModel.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    trackEvent('chat_send_prompt', {
      model: selectedModel,
      length: message && 'text' in message ? (message.text?.length ?? 0) : 0,
      prompt_number: instance.messages.length + 1,
    })

    return originalSendMessage(
      {
        ...message,
        metadata: {
          ...message?.metadata,
          modelId: selectedModel.id,
        },
      } as ThunderboltUIMessage,
      options,
    )
  }

  return instance
}
