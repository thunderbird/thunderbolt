/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ChatUI from '@/components/chat/chat-ui'
import { MiniAppChatBanner } from '@/mini-apps/mini-app-chat-banner'
import { useChatDestination } from '@/mini-apps/use-chat-destination'
import { useMiniApps } from '@/mini-apps/use-mini-apps'
import { useCurrentChatSession } from './chat-store'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { type PropsWithChildren, useEffect, useState } from 'react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { Navigate, useParams, useSearchParams } from 'react-router'
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
  /** Mini App this chat starts from. New chats only; set by the app page. */
  miniAppId?: string | null
  /**
   * Called with the thread id once the first send persists it.
   *
   * Supplying it also suppresses the route's default navigation to
   * `/chats/<id>`, which is what an embedded host needs — navigating would
   * unmount the surface the chat is sitting in.
   */
  onCreated?: (chatThreadId: string) => void
}>

/**
 * Exported so surfaces other than the `/chats/:id` route can host a real chat
 * session — `ChatUI` takes no props and reads `useCurrentChatSession()`, so it
 * only works inside this handler. The Mini Apps side panel
 * (`src/mini-apps/mini-app-page.tsx`) is the current second caller.
 */
export const ChatHydrateHandler = ({
  children,
  existingId,
  projectId,
  newChatId,
  miniAppId = null,
  onCreated,
}: ChatHydrateHandlerProps) => {
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
    miniAppId,
    onCreated,
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

/**
 * The chat, plus a note about where it came from.
 *
 * Inside the handler because the origin lives on the hydrated session, and only
 * on this route: beside the app itself the provenance is the screen.
 */
const ChatWithOrigin = ({ chatThreadId }: { chatThreadId: string }) => {
  const { miniAppId } = useCurrentChatSession()
  const { loading, failed } = useMiniApps()
  const chatDestination = useChatDestination()

  if (!miniAppId) {
    return <ChatUI />
  }

  /*
   * Decide nothing until the registry has answered.
   *
   * `useChatDestination` resolves against the app list, and an unanswered
   * registry looks exactly like a deregistered app — so a cold deep link used to
   * mount and hydrate the chat here, then redirect into `/apps/:id` the moment
   * the list landed, tearing the session down and rebuilding it. The banner and
   * `MiniAppPage` both wait on this for the same reason.
   *
   * A *failed* registry falls through deliberately: it may never answer, and the
   * conversation is more useful than a spinner. The banner stays quiet in that
   * state rather than claiming the app is gone.
   */
  if (loading && !failed) {
    return <ChatUI />
  }

  /*
   * A chat that came from an app opens inside it. The sidebar already routes
   * there directly, so this catches the ways in that don't: a deep link, the
   * search palette, a shared URL. `replace` because `/chats/:id` was never a
   * place the user meant to be — Back should return where they came from.
   *
   * When the app route can't host it (a phone, an app that is no longer
   * registered) `useChatDestination` hands back this same URL, and the banner
   * below says where the conversation started instead.
   */
  const destination = chatDestination(chatThreadId, miniAppId)
  if (destination !== `/chats/${chatThreadId}`) {
    return <Navigate to={destination} replace />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MiniAppChatBanner appId={miniAppId} chatThreadId={chatThreadId} />
      <div className="min-h-0 flex-1">
        <ChatUI />
      </div>
    </div>
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
      <ChatWithOrigin chatThreadId={chatThreadId} />
    </ChatHydrateHandler>
  )
}
