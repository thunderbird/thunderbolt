import { aiFetchStreamingResponse } from '@/ai/fetch'
import { trackEvent } from '@/lib/posthog'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { useChatStore } from './chat-store'

export const maxRetries = 3

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

  let retryCount = 0
  let retryTimeout: ReturnType<typeof setTimeout> | null = null

  const instance = new Chat<ThunderboltUIMessage>({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message, isError, isAbort }) => {
      if (isAbort) return

      // Empty response without an error flag — treat as a retryable failure
      const isEmptyResponse = !isError && !message.parts?.length

      if (!isError && !isEmptyResponse) {
        retryCount = 0
        useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })

        const { sessions } = useChatStore.getState()

        const session = sessions.get(id)

        if (!session) throw new Error('No session found')

        await saveMessages({ id, messages: [message] })

        trackEvent('chat_receive_reply', {
          model: session.selectedModel,
          length: message.parts?.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0) || 0,
          reply_number: instance.messages.length + 1,
        })

        return
      }

      if (retryCount < maxRetries) {
        retryCount++
        useChatStore.getState().updateSession(id, { retryCount })
        console.info(`Auto-retrying (${retryCount}/${maxRetries})...`)
        retryTimeout = setTimeout(() => {
          retryTimeout = null
          instance.regenerate().catch((err) => {
            console.error('Auto-retry failed:', err)
          })
        }, 2000 * retryCount)
      } else {
        useChatStore.getState().updateSession(id, { retriesExhausted: true })
      }
    },
    onError: (error) => {
      console.error('Chat error:', error)
    },
  })

  const originalRegenerate = instance.regenerate.bind(instance)

  // Reset retry count on manual regenerate (Retry button) so auto-retries work again
  instance.regenerate = async function () {
    retryCount = 0
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
    return originalRegenerate()
  }

  const originalSendMessage = instance.sendMessage.bind(instance)

  // Override the sendMessage method to check if the model is available for the chat thread
  instance.sendMessage = async function (message, options) {
    // Cancel any pending auto-retry and reset error state for the new message
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    retryCount = 0
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })

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
