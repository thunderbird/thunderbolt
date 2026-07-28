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
import { loadChatMessageList } from '@/components/chat/chat-messages-loader'
import { PageFallback } from '@/loading'

type ChatHydrateHandlerProps = PropsWithChildren<{
  id: string
  isNew: boolean
}>

const ChatHydrateHandler = ({ children, id, isNew }: ChatHydrateHandlerProps) => {
  const { hydrateChatStore, isReady, saveMessages, saveStreamingMessage } = useHydrateChatStore({ id, isNew })

  useHandleIntegrationCompletion({ saveMessages })

  useEffect(() => {
    hydrateChatStore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Visible feedback while an existing thread hydrates (message load +
  // session setup): sidebar taps navigate here immediately, so this spinner —
  // not a blank pane — is what shows while a long chat loads. New chats skip
  // it: their hydration is a few fast reads, and flashing a second spinner
  // right after the app-boot one reads as a glitch on first load.
  if (!isReady) {
    return isNew ? null : <PageFallback />
  }

  return (
    <SavePartialAssistantMessagesHandler saveStreamingMessage={saveStreamingMessage}>
      {children}
    </SavePartialAssistantMessagesHandler>
  )
}

export default function ChatDetailPage() {
  const params = useParams()

  const isNew = params.chatThreadId === 'new'

  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [isNew, params.chatThreadId])

  // Warm the lazily-split message subtree for new chats as well as existing
  // ones: the first send swaps the empty state for the message list mid-
  // animation, and an unloaded chunk would leave the enter fade running over
  // an empty Suspense shell with the messages popping in afterwards. Firing
  // from an effect keeps the chunk out of the entry bundle either way.
  useEffect(() => {
    void loadChatMessageList()
  }, [])

  if (!id) {
    return null
  }

  return (
    <ChatHydrateHandler key={id} id={id} isNew={isNew}>
      <ChatUI />
    </ChatHydrateHandler>
  )
}
