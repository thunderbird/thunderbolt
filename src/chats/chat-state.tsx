import { aiFetchStreamingResponse } from '@/ai/fetch'
import ChatUI from '@/components/chat/chat-ui'
import { useSettings } from '@/hooks/use-settings'
import { useThrottledCallback } from '@/hooks/use-throttle'
import { trackEvent } from '@/lib/posthog'
import { getDefaultModelForThread, getTriggerPromptForThread } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useChat, type UseChatHelpers } from '@ai-sdk/react'
import { useQuery } from '@tanstack/react-query'
import { DefaultChatTransport } from 'ai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'

interface ChatStateProps {
  id: string
  models: Model[]
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

export default function ChatState({ id, models, initialMessages, saveMessages }: ChatStateProps) {
  const { getEnabledClients } = useMCP()
  const location = useLocation()
  const queryClient = useQueryClient()

  const { selectedModel } = useSettings({
    selected_model: '',
  })

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const selectedModelIdRef = useRef<string | null>(null)

  // Keep ref in sync with state so fetch always sees latest value
  useEffect(() => {
    selectedModelIdRef.current = selectedModelId
  }, [selectedModelId])

  const { data: defaultModel } = useQuery<Model>({
    queryKey: ['models', 'defaultModel', id],
    queryFn: () => getDefaultModelForThread(id, selectedModel.value ?? undefined),
  })

  const handleModelChange = (modelId: string | null) => {
    setSelectedModelId(modelId)
    selectedModel.setValue(modelId)
    trackEvent('model_select', { model: modelId })
  }

  useEffect(() => {
    if (defaultModel) {
      setSelectedModelId(defaultModel.id)
    }
  }, [defaultModel])

  // Hydrate the singleton store the first time a thread is opened
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      // The useChat hook will handle initializing the store with initialMessages
    }
  }, [id, initialMessages])

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
        reply_number: chatMessages.length + 1,
      })
    },
    onError: (error) => {
      console.error('Chat error:', error)
      // The error will be available in chatHelpers.error for the UI to display
    },
  })

  useSavePartialAssistantMessages({ chatHelpers, id, saveMessages })

  const { messages: chatMessages, status } = chatHelpers

  // Load the automation prompt that triggered this chat, if any
  const { data: triggerData } = useQuery({
    queryKey: ['triggerPrompt', id],
    queryFn: () => getTriggerPromptForThread(id),
  })

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  const hasTriggeredRef = useRef(false)
  useEffect(() => {
    if (hasTriggeredRef.current) return

    if (
      selectedModelId &&
      status === 'ready' &&
      chatMessages.length > 0 &&
      chatMessages[chatMessages.length - 1].role === 'user'
    ) {
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      chatHelpers.regenerate().catch((err) => {
        hasTriggeredRef.current = false
        console.error('Auto regenerate error', err)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedModelId])

  // Check for OAuth retry trigger and regenerate to continue original request
  const oauthRetryTriggeredRef = useRef(false)

  const checkAndTriggerRetry = useCallback(() => {
    if (oauthRetryTriggeredRef.current) return
    if (!selectedModelId || status !== 'ready' || chatMessages.length === 0) return

    const shouldRetry = sessionStorage.getItem('oauth_trigger_retry') === 'true'
    if (!shouldRetry) return

    const lastUserMessage = chatMessages
      .slice()
      .reverse()
      .find((msg) => msg.role === 'user')

    // Continue the action without removing the widget message
    // We'll use regenerate() which removes the last assistant message (widget),
    // but we'll restore it after streaming completes and preserve the sessionStorage flags
    if (lastUserMessage && chatMessages[chatMessages.length - 1]?.role === 'assistant') {
      oauthRetryTriggeredRef.current = true
      sessionStorage.removeItem('oauth_trigger_retry')

      // Store the widget message and its ID to restore it after regeneration
      const widgetMessage = chatMessages[chatMessages.length - 1]
      const widgetMessageId = widgetMessage.id

      // Get and preserve the stored provider from sessionStorage
      const storedProvider = sessionStorage.getItem(`oauth_widget_${widgetMessageId}_provider`) as
        | 'google'
        | 'microsoft'
        | null
      const wasCompleted = sessionStorage.getItem(`oauth_widget_${widgetMessageId}_completed`) === 'true'

      // Delay to ensure state is stable after navigation
      setTimeout(() => {
        // Regenerate will remove the widget message, so we restore it after streaming completes
        chatHelpers.regenerate().catch((err) => {
          oauthRetryTriggeredRef.current = false
          console.error('OAuth retry regenerate error', err)
        })

        // Watch for when regeneration completes (status changes to ready and new message appears)
        // Then restore the widget message with its connected state
        let lastMessageCount = chatHelpers.messages.length
        const checkComplete = setInterval(() => {
          const currentMessageCount = chatHelpers.messages.length
          const isReady = chatHelpers.status === 'ready'

          // Check if regeneration completed (new message appeared and streaming stopped)
          if (isReady && currentMessageCount > lastMessageCount) {
            // Regeneration completed - restore the widget
            clearInterval(checkComplete)

            if (widgetMessage && storedProvider && wasCompleted) {
              // Re-set the sessionStorage flags BEFORE restoring the message
              // so the widget component sees them on mount
              sessionStorage.setItem(`oauth_widget_${widgetMessageId}_provider`, storedProvider)
              sessionStorage.setItem(`oauth_widget_${widgetMessageId}_completed`, 'true')

              // Restore the widget message with connected state flags
              const currentMessages = [...chatHelpers.messages]
              // Find the last user message index
              let lastUserIndex = -1
              for (let i = currentMessages.length - 1; i >= 0; i--) {
                if (currentMessages[i]?.role === 'user') {
                  lastUserIndex = i
                  break
                }
              }
              if (lastUserIndex >= 0) {
                // Insert widget message after the user message, before the new assistant response
                const newMessages = [
                  ...currentMessages.slice(0, lastUserIndex + 1),
                  widgetMessage,
                  ...currentMessages.slice(lastUserIndex + 1),
                ]
                chatHelpers.setMessages(newMessages)
                // Also update React Query cache to keep widget in memory without persisting to DB
                queryClient.setQueryData(['chatMessages', id], newMessages)
              }
            }
          }

          lastMessageCount = currentMessageCount
        }, 100)

        // Clear interval after 30 seconds to prevent infinite loop
        setTimeout(() => clearInterval(checkComplete), 30000)
      }, 1000)
    }
  }, [selectedModelId, status, chatMessages, chatHelpers, id, queryClient])

  // Check on mount and when dependencies change
  useEffect(() => {
    checkAndTriggerRetry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedModelId, chatMessages.length, location.pathname, location.state])

  // Listen for custom event from widget
  useEffect(() => {
    const handleRetryTrigger = () => {
      // Small delay to ensure sessionStorage is updated
      setTimeout(() => {
        checkAndTriggerRetry()
      }, 100)
    }

    window.addEventListener('oauth-retry-trigger', handleRetryTrigger)
    return () => window.removeEventListener('oauth-retry-trigger', handleRetryTrigger)
  }, [checkAndTriggerRetry])

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
