/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useMemo } from 'react'
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
