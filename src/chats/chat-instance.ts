import { aiFetchStreamingResponse } from '@/ai/fetch'
import { isRateLimitError } from '@/lib/error-utils'
import type { HttpClient } from '@/lib/http'
import { trackEvent } from '@/lib/posthog'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { useChatStore } from './chat-store'

export const maxRetries = 3

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Jitter prevents synchronized retries from overwhelming servers.
 */
const getRetryDelay = (attempt: number) => 2000 * attempt * (0.5 + Math.random())

export const createChatInstance = (
  id: string,
  messages: ThunderboltUIMessage[],
  saveMessages: SaveMessagesFunction,
  httpClient: HttpClient,
) => {
  const customFetch = Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        throw new Error('Missing init')
      }

      const { mcpClients, sessions } = useChatStore.getState()

      const session = sessions.get(id)

      if (!session) {
        throw new Error('No session found')
      }

      return aiFetchStreamingResponse({
        init,
        saveMessages,
        modelId: session.selectedModel.id,
        modeSystemPrompt: session.selectedMode.systemPrompt ?? undefined,
        modeName: session.selectedMode.name ?? undefined,
        mcpClients,
        httpClient,
      })
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )

  let retryCount = 0
  let retryTimeout: ReturnType<typeof setTimeout> | null = null
  let lastError: Error | null = null

  const instance = new Chat<ThunderboltUIMessage>({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message, isError, isAbort }) => {
      if (isAbort) {
        // Clear any pending retry timer and reset retry state when aborted
        if (retryTimeout) {
          clearTimeout(retryTimeout)
          retryTimeout = null
        }
        retryCount = 0
        lastError = null
        useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
        return
      }

      // Handle successful responses: message exists, no error, and has parts
      if (!isError && message && message.parts?.length) {
        retryCount = 0
        lastError = null
        useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })

        const { sessions } = useChatStore.getState()

        const session = sessions.get(id)

        if (!session) {
          throw new Error('No session found')
        }

        await saveMessages({ id, messages: [message] })

        trackEvent('chat_receive_reply', {
          model: session.selectedModel,
          length: message.parts.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0),
          reply_number: instance.messages.length + 1,
        })

        return
      }

      // Don't auto-retry rate limit errors — retrying immediately makes it worse
      if (isRateLimitError(lastError)) {
        lastError = null
        useChatStore.getState().updateSession(id, { retriesExhausted: true })
        return
      }

      if (retryCount < maxRetries) {
        retryCount++
        useChatStore.getState().updateSession(id, { retryCount })
        console.info(`Auto-retrying (${retryCount}/${maxRetries})...`)

        trackEvent('chat_auto_retry', { attempt: retryCount, max_retries: maxRetries })

        retryTimeout = setTimeout(() => {
          retryTimeout = null
          const { sessions, currentSessionId } = useChatStore.getState()
          // Only retry if the session still exists AND is still the current active session.
          // This prevents retries from executing when the user has switched to a different thread.
          if (!sessions.has(id) || currentSessionId !== id) {
            // Reset retry state when bailing out due to session switch, so the UI
            // doesn't show "Retrying..." when the user switches back to this session.
            retryCount = 0
            useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
            return
          }
          originalRegenerate().catch((err) => {
            console.error('Auto-retry failed:', err)
            // Don't set retriesExhausted here - let onFinish handle retry logic.
            // When originalRegenerate() fails, onFinish will be called again and will
            // either schedule another retry (if retryCount < maxRetries) or set
            // retriesExhausted: true (if retries are exhausted).
          })
        }, getRetryDelay(retryCount))
      } else {
        useChatStore.getState().updateSession(id, { retriesExhausted: true })
      }
    },
    // Retry logic lives in onFinish (the SDK's finally block), not here.
    // Adding retries to onError caused infinite loops in earlier iterations
    // because onFinish resets state that onError depends on. If onFinish
    // somehow doesn't fire, chatError is set by the SDK and retryCount
    // stays at 0, so the UI shows the Retry button immediately.
    onError: (error) => {
      console.error('Chat error:', error)
      lastError = error instanceof Error ? error : new Error(String(error))
    },
  })

  const originalRegenerate = instance.regenerate.bind(instance)

  // Reset retry count on manual regenerate (Retry button) so auto-retries work again
  instance.regenerate = async function () {
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    retryCount = 0
    lastError = null
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
    lastError = null
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })

    const { sessions } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

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
