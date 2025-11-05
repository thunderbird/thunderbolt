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
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'
import { DefaultChatTransport } from 'ai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

type ChatStateProps = {
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

  const { selectedModel } = useSettings({
    selected_model: '',
  })

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const selectedModelIdRef = useRef<string | null>(null)

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
    },
  })

  useSavePartialAssistantMessages({ chatHelpers, id, saveMessages })

  const { messages: chatMessages, status } = chatHelpers

  const { data: triggerData } = useQuery({
    queryKey: ['triggerPrompt', id],
    queryFn: () => getTriggerPromptForThread(id),
  })

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
      const triggerRegenerate = async () => {
        try {
          await chatHelpers.regenerate()
        } catch (err) {
          hasTriggeredRef.current = false
          console.error('Auto regenerate error', err)
        }
      }
      triggerRegenerate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedModelId])

  useHandleIntegrationCompletion({
    chatHelpers,
    saveMessages,
    id,
    status,
    chatMessages,
    hasTriggeredRef,
  })

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
