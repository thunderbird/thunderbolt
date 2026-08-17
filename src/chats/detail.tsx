/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useState } from 'react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useParams, useSearchParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { useHandleIntegrationCompletion } from '@/hooks/use-handle-integration-completion'
import { loadChatMessageList } from '@/components/chat/chat-messages-loader'
import { PageFallback } from '@/loading'

type ChatHydrateHandlerProps = PropsWithChildren<{
  /** The thread from the route, or null for a chat that doesn't exist yet. */
  existingId: string | null
  /** Project this chat starts in, from `?projectId=`. New chats only. */
  projectId: string | null
}>

const ChatHydrateHandler = ({ children, existingId, projectId }: ChatHydrateHandlerProps) => {
  const isNew = existingId === null
  // A new chat's id is minted here, once per mount: `useState`'s initializer is a
  // guarantee, where a `useMemo` is only a hint. React is free to drop a memo
  // cache and recompute, which would mint a second id for the same chat and
  // remount the thread the user is mid-way through composing. The mount itself is
  // keyed by the route below, so a genuinely different chat gets a fresh id.
  const [id] = useState(() => existingId ?? uuidv7())

  const { hydrateChatStore, isReady, saveMessages, saveStreamingMessage } = useHydrateChatStore({
    id,
    isNew,
    projectId,
  })

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
  const [searchParams] = useSearchParams()

  const chatThreadId = params.chatThreadId
  const isNew = chatThreadId === 'new'

  // A new chat's project comes from the URL, and nothing is persisted yet, so the
  // query string is part of the chat's identity. Without it in the key, going
  // from `/chats/new?projectId=X` to `/chats/new` reused the same chat: no
  // remount, no re-hydration, and the session kept project X — silently filing
  // the first message under a project the user had just left.
  const projectId = isNew ? searchParams.get('projectId') : null

  // Warm the lazily-split message subtree for new chats as well as existing
  // ones: the first send swaps the empty state for the message list mid-
  // animation, and an unloaded chunk would leave the enter fade running over
  // an empty Suspense shell with the messages popping in afterwards. Firing
  // from an effect keeps the chunk out of the entry bundle either way.
  useEffect(() => {
    void loadChatMessageList()
  }, [])

  if (!chatThreadId) {
    return null
  }

  return (
    // Keyed on the chat's identity rather than its id: the route's thread, or "a
    // new chat in this project". Navigating between two of those remounts the
    // handler, which is what re-hydrates the store and re-mints a new chat's id.
    <ChatHydrateHandler
      key={isNew ? `new:${projectId ?? ''}` : chatThreadId}
      existingId={isNew ? null : chatThreadId}
      projectId={projectId}
    >
      <ChatUI />
    </ChatHydrateHandler>
  )
}
