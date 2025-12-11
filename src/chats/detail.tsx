import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useMemo } from 'react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'

type ChatHydrateHandlerProps = PropsWithChildren<{
  id: string
}>

const ChatHydrateHandler = ({ children, id }: ChatHydrateHandlerProps) => {
  const { hydrateChatStore, isReady, saveMessages } = useHydrateChatStore({ id })

  useHandleIntegrationCompletion({ saveMessages })

  useEffect(() => {
    hydrateChatStore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (!isReady) {
    return null
  }

  return (
    <SavePartialAssistantMessagesHandler saveMessages={saveMessages}>{children}</SavePartialAssistantMessagesHandler>
  )
}

export default function ChatDetailPage() {
  const params = useParams()

  const id = useMemo(
    () => (params.chatThreadId === 'new' ? uuidv7() : params.chatThreadId || null),
    [params.chatThreadId],
  )

  if (!id) {
    return null
  }

  return (
    <ChatHydrateHandler key={id} id={id}>
      <ChatUI />
    </ChatHydrateHandler>
  )
}
