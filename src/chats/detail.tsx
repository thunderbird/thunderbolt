import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useMemo, useState } from 'react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'

type ChatHydrateHandlerProps = PropsWithChildren<{
  id: string
  isNew: boolean
}>

const ChatHydrateHandler = ({ children, id, isNew }: ChatHydrateHandlerProps) => {
  const { hydrateChatStore, isReady, saveMessages } = useHydrateChatStore({ id, isNew })
  const [error, setError] = useState<Error | null>(null)

  useHandleIntegrationCompletion({ saveMessages })

  useEffect(() => {
    hydrateChatStore().catch((err: unknown) => {
      console.error('Failed to hydrate chat store:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

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
    <SavePartialAssistantMessagesHandler saveMessages={saveMessages}>{children}</SavePartialAssistantMessagesHandler>
  )
}

export default function ChatDetailPage() {
  const params = useParams()

  const isNew = params.chatThreadId === 'new'

  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [params.chatThreadId])

  if (!id) {
    return null
  }

  return (
    <ChatHydrateHandler key={id} id={id} isNew={isNew}>
      <ChatUI />
    </ChatHydrateHandler>
  )
}
