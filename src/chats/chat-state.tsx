import ChatUI from '@/components/chat/chat-ui'
import { chatThreadsTable, modelsTable, promptsTable, settingsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { aiFetchStreamingResponse } from '@/lib/ai'
import { getOrCreateChatStore } from '@/lib/chat-store-registry'
import { getSelectedModel } from '@/lib/dal'
import { useMCP } from '@/lib/mcp-provider'
import { Model, SaveMessagesFunction } from '@/types'
import { useChat } from '@ai-sdk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { useEffect } from 'react'
import { v7 as uuidv7 } from 'uuid'

// Types for optional automation prompt
type TriggerPromptInfo = {
  title: string | null
  prompt: string
} | null

interface ChatStateProps {
  id: string
  models: Model[]
  initialMessages: UIMessage[] | undefined
  saveMessages: SaveMessagesFunction
}

export default function ChatState({ id, models, initialMessages, saveMessages }: ChatStateProps) {
  const queryClient = useQueryClient()
  const { db } = useDatabase()
  const { getEnabledClients } = useMCP()

  const { data: selectedModel } = useQuery<Model>({
    queryKey: ['selected_model_for_thread', id],
    queryFn: async () => {
      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
      if (thread?.triggeredBy) {
        const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, thread.triggeredBy)).get()
        if (prompt?.modelId) {
          const model = await db.select().from(modelsTable).where(eq(modelsTable.id, prompt.modelId)).get()
          if (model) return model
        }
      }
      return await getSelectedModel()
    },
    initialData: models[0],
  })

  // Fetch automation prompt details (if any) for this thread
  const { data: triggerPrompt } = useQuery<TriggerPromptInfo>({
    queryKey: ['trigger_prompt_info', id],
    queryFn: async () => {
      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
      if (thread?.triggeredBy) {
        const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, thread.triggeredBy)).get()
        if (prompt) {
          return { title: prompt.title, prompt: prompt.prompt }
        }
      }
      return null
    },
  })

  // Hydrate the singleton store the first time a thread is opened
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      // The useChat hook will handle initializing the store with initialMessages
    }
  }, [id, initialMessages])

  const selectModelMutation = useMutation({
    mutationFn: async (modelId: string) => {
      await db.delete(settingsTable).where(eq(settingsTable.key, 'selected_model'))
      await db.insert(settingsTable).values({ key: 'selected_model', value: modelId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['selected_model_for_thread', id] })
    },
  })

  const handleModelChange = (modelId: string | null) => {
    if (modelId) {
      selectModelMutation.mutate(modelId)
    }
  }

  // Memoize fetch function to keep stable reference per render
  const customFetch = async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
    if (!init) throw new Error('Missing init')
    const model = await getSelectedModel()
    return aiFetchStreamingResponse({
      init,
      saveMessages,
      model,
      mcpClients: getEnabledClients(),
    })
  }

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

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    if (status === 'ready' && chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
      // Trigger LLM response once automatically
      chatHelpers.reload().catch((err) => console.error('Auto reload error', err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  return (
    <ChatUI
      chatHelpers={chatHelpers}
      models={models}
      selectedModel={selectedModel?.id ?? null}
      onModelChange={handleModelChange}
      triggerPrompt={triggerPrompt}
    />
  )
}
