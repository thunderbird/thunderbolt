import ChatUI from '@/components/chat/chat-ui'
import { getSelectedModel } from '@/dal'
import { settingsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { aiFetchStreamingResponse } from '@/lib/ai'
import { useMCP } from '@/lib/mcp-provider'
import { Model, SaveMessagesFunction } from '@/types'
import { useChat } from '@ai-sdk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultChatStore, UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

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
    queryKey: ['settings', 'selected_model'],
    queryFn: async () => {
      return await getSelectedModel()
    },
    initialData: models[0],
  })

  const selectModelMutation = useMutation({
    mutationFn: async (modelId: string) => {
      await db.delete(settingsTable).where(eq(settingsTable.key, 'selected_model'))
      await db.insert(settingsTable).values({ key: 'selected_model', value: modelId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'selected_model'] })
    },
  })

  const handleModelChange = (modelId: string | null) => {
    if (modelId) {
      selectModelMutation.mutate(modelId)
    }
  }

  const chatStore = defaultChatStore({
    maxSteps: 5,
    api: '/api/chat',
    generateId: uuidv7,
    chats: {
      [id]: {
        messages: initialMessages ?? [],
      },
    },
    fetch: async (_requestInfoOrUrl: RequestInfo | URL, init?: RequestInit) => {
      try {
        if (!init) {
          throw new Error('No init found')
        }

        const model = await getSelectedModel()

        // All models now use the standard AI SDK flow
        // Flower models will use the custom provider with encryption support
        return aiFetchStreamingResponse({
          init,
          saveMessages,
          model,
          mcpClients: getEnabledClients(),
        })
      } catch (error) {
        console.error('Error in fetch:', error)
        throw error
      }
    },
  })

  const chatHelpers = useChat({
    id,
    chatStore,
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

  return <ChatUI chatHelpers={chatHelpers} models={models} selectedModel={selectedModel?.id ?? null} onModelChange={handleModelChange} />
}
