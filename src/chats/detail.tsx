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
  /**
   * The id a new chat will be saved under, minted by the route so it can key on
   * it (see {@link useNewChatId}). Ignored once `existingId` is set — by then the
   * two are the same id anyway.
   */
  newChatId: string
}>

const ChatHydrateHandler = ({ children, existingId, projectId, newChatId }: ChatHydrateHandlerProps) => {
  const isNew = existingId === null
  // Held in `useState` rather than read from props each render: `useState`'s
  // initializer is a guarantee where a `useMemo` is only a hint, and the id must
  // not change under a chat the user is mid-way through composing. A genuinely
  // different chat arrives as a different key and remounts this.
  const [id] = useState(() => existingId ?? newChatId)

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

/**
 * A stable id for the chat being composed at `/chats/new`.
 *
 * Minted once per visit and handed to the handler as `newChatId`, so that when
 * the first send persists the thread and navigates to `/chats/<that id>`, the
 * route key is *already* that id — the subtree re-renders instead of remounting.
 *
 * That remount is what broke voice mode (THU-854): the session lives in a ref
 * inside the composer, so unmounting it tore down the mic mid-turn and the first
 * spoken reply never arrived. Typed chat never noticed, because its `Chat`
 * instance lives in the chat store and `hydrateChatStore` early-returns for an
 * id it already has — the remount was pure waste even before it caused a bug.
 *
 * Re-minting happens during render rather than in an effect: the fresh id has to
 * be on the very render that enters the new-chat state, or the key would point
 * at the previous chat for a frame.
 */
export const useNewChatId = (isNew: boolean, projectId: string | null): string => {
  const [minted, setMinted] = useState(() => uuidv7())
  // Which new-chat visit `minted` belongs to. Null while a persisted thread is
  // open, so returning to /chats/new always reads as a new visit.
  const visit = isNew ? (projectId ?? '') : null
  const [mintedFor, setMintedFor] = useState<string | null>(visit)

  if (visit !== mintedFor) {
    setMintedFor(visit)
    // Leaving /chats/new keeps the id: the navigation the first send triggers
    // goes to exactly this id, and re-minting there would defeat the whole point.
    if (visit !== null) {
      setMinted(uuidv7())
    }
  }

  return minted
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
  const newChatId = useNewChatId(isNew, projectId)

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
    // Keyed on the chat's own id in both states — the id minted for this visit to
    // /chats/new, then the same id once the first send navigates to it. Switching
    // to a different thread, or starting another new chat, still changes the key
    // and remounts; only the new→persisted step of one chat is now continuous.
    <ChatHydrateHandler
      key={isNew ? newChatId : chatThreadId}
      existingId={isNew ? null : chatThreadId}
      newChatId={newChatId}
      projectId={projectId}
    >
      <ChatUI />
    </ChatHydrateHandler>
  )
}
