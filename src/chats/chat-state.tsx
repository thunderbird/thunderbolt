import { aiFetchStreamingResponse } from '@/ai/fetch'
import ChatUI from '@/components/chat/chat-ui'
import { useSetting } from '@/hooks/use-setting'
import { getOrCreateChatStore } from '@/lib/chat-store-registry'
import { getDefaultModelForThread, getTriggerPromptForThread } from '@/lib/dal'
import { useMCP } from '@/lib/mcp-provider'
import { Model, Prompt, SaveMessagesFunction } from '@/types'
import { useChat } from '@ai-sdk/react'
import { useQuery } from '@tanstack/react-query'
import { UIMessage } from 'ai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

interface ChatStateProps {
  id: string
  models: Model[]
  initialMessages: UIMessage[] | undefined
  saveMessages: SaveMessagesFunction
}

export default function ChatState({ id, models, initialMessages, saveMessages }: ChatStateProps) {
  const { getEnabledClients } = useMCP()

  const [defaultModelId, setDefaultModelId] = useSetting<string>('selected_model')

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const selectedModelIdRef = useRef<string | null>(null)

  // Keep ref in sync with state so fetch always sees latest value
  useEffect(() => {
    selectedModelIdRef.current = selectedModelId
  }, [selectedModelId])

  const { data: selectedModel } = useQuery<Model>({
    queryKey: ['defaultModel', id],
    queryFn: () => getDefaultModelForThread(id, defaultModelId ?? undefined),
  })

  const handleModelChange = (modelId: string | null) => {
    setSelectedModelId(modelId)
    setDefaultModelId(modelId)
  }

  useEffect(() => {
    if (selectedModel) {
      setSelectedModelId(selectedModel.id)
    }
  }, [selectedModel])

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

  const chatStoreInstance = getOrCreateChatStore(id, {
    initialMessages: initialMessages ?? [],
    fetch: customFetch,
  })

  const chatHelpers = useChat({
    id,
    chatStore: chatStoreInstance,
    generateId: uuidv7,
    onFinish: async ({ message }) => {
      await saveMessages({
        id,
        messages: [message],
      })
    },
    onError: (error) => {
      console.error('Chat error:', error)
      // The error will be available in chatHelpers.error for the UI to display
    },
  })

  const { messages: chatMessages, status } = chatHelpers

  // Load the automation prompt that triggered this chat, if any
  const { data: triggerPrompt } = useQuery<Prompt | null>({
    queryKey: ['triggerPrompt', id],
    queryFn: () => getTriggerPromptForThread(id),
  })

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    // Ensure we have a model selected before attempting to reload
    if (
      selectedModelId &&
      status === 'ready' &&
      chatMessages.length > 0 &&
      chatMessages[chatMessages.length - 1].role === 'user'
    ) {
      // Trigger LLM response once automatically
      chatHelpers.reload().catch((err) => console.error('Auto reload error', err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedModelId])

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
      triggerPrompt={triggerPrompt ?? undefined}
    />
  )
}
