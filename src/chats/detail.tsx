import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useMemo } from 'react'
import { useChatAutomation } from './use-chat-automation'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

type ChatHydrateHandlerProps = PropsWithChildren<{
  id: string
  isNew: boolean
}>

const ChatHydrateHandler = ({ children, id, isNew }: ChatHydrateHandlerProps) => {
  const { hydrateChatStore, isReady, saveMessages } = useHydrateChatStore({ id, isNew })

  useChatAutomation()

  useEffect(() => {
    hydrateChatStore()
  }, [hydrateChatStore])

  console.log(isReady)

  if (!isReady) {
    return null
  }

  return (
    <SavePartialAssistantMessagesHandler saveMessages={saveMessages}>{children}</SavePartialAssistantMessagesHandler>
  )
}

export default function ChatDetailPage() {
  const params = useParams()

  const isNew = useMemo(() => params.chatThreadId === 'new', [params.chatThreadId])

  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [isNew, params.chatThreadId])

  if (!id) {
    return null
  }

  return (
    <ChatHydrateHandler key={id} id={id} isNew={isNew}>
      <ChatUI />
    </ChatHydrateHandler>
  )
}
