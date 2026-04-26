import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { useEffect, useMemo, useState } from 'react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useParams, useLocation } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'

type ChatHydrateHandlerProps = {
  id: string
  isNew: boolean
}

const ChatHydrateHandler = ({ id, isNew }: ChatHydrateHandlerProps) => {
  const { hydrateChatStore, isReady, saveMessages } = useHydrateChatStore({ id, isNew })
  const [error, setError] = useState<Error | null>(null)

  useHandleIntegrationCompletion({ saveMessages })

  // Re-hydrate when `id` changes (navigating to a different chat).
  // `hydrateChatStore` is intentionally excluded from deps — it's a stable function
  // but would cause double-hydration if included, since it closes over `id`.
  useEffect(() => {
    hydrateChatStore().catch((err: unknown) => {
      console.error('Failed to hydrate chat store:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-8 text-center">
        <div className="flex flex-col gap-2 max-w-md">
          <p className="text-destructive font-medium">Failed to load chat</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    )
  }

  if (!isReady) {
    return null
  }

  return (
    <SavePartialAssistantMessagesHandler saveMessages={saveMessages}>
      <ChatUI saveMessages={saveMessages} />
    </SavePartialAssistantMessagesHandler>
  )
}

const ChatDetailPage = () => {
  const params = useParams()
  const location = useLocation()

  const isNew = params.chatThreadId === 'new'

  // Include agentSwitch state in deps so switching agents on /chats/new generates a fresh session ID
  const agentSwitch = (location.state as { agentSwitch?: number } | null)?.agentSwitch
  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [params.chatThreadId, agentSwitch])

  if (!id) {
    return null
  }

  return <ChatHydrateHandler key={id} id={id} isNew={isNew} />
}

export default ChatDetailPage
