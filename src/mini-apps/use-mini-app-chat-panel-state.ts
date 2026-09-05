/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Which conversation the Mini App panel is showing, and how it gets there.
 *
 * Extracted from `MiniAppView`, which owned this alongside the bridge
 * lifecycle, the element picker and the whole split layout — one component
 * holding five unrelated concerns, none of them reachable from a test. Every
 * data-loss bug this panel had lived in exactly this logic: reopening a real
 * thread as an empty draft, an app's prompt discarding the conversation on
 * screen, a close that ended the conversation instead of putting it away.
 *
 * It owns no DOM and no bridge, so it can be driven directly.
 */

import { useCallback, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

import { useChatStore } from '@/chats/chat-store'
import { setPendingPrompt } from '@/chats/pending-prompt-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'

export type MiniAppChatPanelState = {
  /** The conversation on screen, or null when the panel is closed. */
  openChatId: string | null
  /**
   * Set while that conversation has no row yet. The panel hands this to
   * `ChatHydrateHandler` to decide between hydrating and starting fresh.
   */
  draftChatId: string | null
  /** Open the panel, seeding the composer if a prompt came with the request. */
  openChat: (prompt?: string) => void
  /** Show a specific persisted thread — the history menu. */
  openExistingChat: (chatThreadId: string) => void
  /** Put the panel away without ending the conversation. */
  closeChat: () => void
  /** Attach highlighted passages to whichever chat ends up on screen. */
  attachToComposer: (passages: string[]) => void
  /** Promote a chat into the URL once its first message has persisted. */
  handleChatCreated: (chatThreadId: string) => void
}

/**
 * Whether this chat has a row behind it.
 *
 * Read from the chat session, which learns the moment the first send creates
 * the row (`updateSession(id, { chatThread })` in `use-hydrate-chat-store`).
 * That makes it the only synchronous, non-racing answer available: the history
 * query answers `[]` while it loads, and `draftChatId` alone is stale for a
 * chat that started as a draft and has since been saved — closing that one
 * recorded it as unsaved and reopening hydrated it empty over its own row.
 *
 * With no session — a cold load where the panel was never opened this run —
 * fall back to the URL, which is only ever set for a thread that exists.
 */
const isPersisted = (chatThreadId: string, hasDraft: boolean): boolean => {
  const session = useChatStore.getState().sessions.get(chatThreadId)
  return session ? session.chatThread !== null : !hasDraft
}

export const useMiniAppChatPanelState = (): MiniAppChatPanelState => {
  /*
   * Two sources, because they are genuinely two states. A persisted thread is
   * addressable, so it lives in `?chat=` and survives a reload or a shared link.
   * A chat the user just opened has no row yet — putting its id in the URL would
   * promise a thread that reloading couldn't find, and hydration would bounce to
   * Not Found. It stays local only until the first message makes it real, at
   * which point `handleChatCreated` promotes it into `?chat=`.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const [draftChatId, setDraftChatId] = useState<string | null>(null)
  const openChatId = draftChatId ?? searchParams.get('chat')

  /*
   * Read through refs, not dependencies. `openChat` is handed to the bridge,
   * which keeps it for the life of the connection — depending on `openChatId`
   * would rebuild the message listener every time a chat opens or closes, and
   * its cleanup aborts in-flight guest requests.
   */
  const openChatIdRef = useRef<string | null>(null)
  openChatIdRef.current = openChatId
  const draftChatIdRef = useRef<string | null>(null)
  draftChatIdRef.current = draftChatId

  /*
   * What was in the panel when it closed, and whether it had a row by then.
   *
   * Recorded at close time rather than re-derived on reopen: the panel knows
   * perfectly well which of the two it was holding, where anything asked
   * afterwards is either loading or already stale.
   */
  const lastChatRef = useRef<{ id: string; persisted: boolean } | null>(null)

  /** Edit only `chat`, leaving any other query the route grows later alone. */
  const setOpenChatParam = useCallback(
    (chatThreadId: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (chatThreadId) {
            next.set('chat', chatThreadId)
          } else {
            next.delete('chat')
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  /**
   * Show a thread that has a row: it lives in the URL, and any draft goes.
   *
   * Two callers with two different reasons — the history menu picking an older
   * thread, and a brand-new chat becoming real on its first message — but one
   * behaviour, so one implementation. They were separate copies of these two
   * lines under separate doc blocks, which reads as though they might differ.
   */
  const showPersistedChat = useCallback(
    (chatThreadId: string) => {
      setDraftChatId(null)
      setOpenChatParam(chatThreadId)
    },
    [setOpenChatParam],
  )

  /**
   * The moment the thread is real it becomes addressable, so it moves out of
   * local state and into the URL.
   *
   * Clearing the draft is half the job and was missing: `openChatId` reads the
   * same id either way, so nothing looked wrong while the panel stayed open —
   * but the chat still counted as a draft, and closing and reopening it
   * hydrated a fresh empty conversation on top of a thread with messages in it.
   */
  const handleChatCreated = showPersistedChat

  /**
   * Put `chatThreadId` on screen, in the URL when it has a row and in local
   * state when it does not.
   *
   * Both entry points (the toggle/`ui/open-chat`, and attaching a passage) go
   * through this so they cannot disagree: an unsaved id in `?chat=` promises
   * hydration a thread it can't find, and a saved id kept out of the URL
   * hydrates an empty conversation over a thread that has messages.
   */
  const showChat = useCallback(
    (chatThreadId: string, persisted: boolean) => {
      if (persisted) {
        showPersistedChat(chatThreadId)
        return
      }
      setDraftChatId(chatThreadId)
      setOpenChatParam(null)
    },
    [showPersistedChat, setOpenChatParam],
  )

  /**
   * Open the chat panel, reusing the conversation already in it.
   *
   * This used to mint a fresh `uuidv7()` every time, which was fine for the
   * toggle button — it only calls this when nothing is open — but wrong for the
   * guest's `ui/open-chat`, which calls it unconditionally. An app asking to
   * open the panel while the user had a conversation in it swapped that
   * conversation out for an empty one.
   *
   * So a conversation is never discarded to satisfy a request to *open*
   * something. A prompt seeds whichever chat ends up on screen, new or
   * existing, and the composer merges it into whatever the user had already
   * typed rather than replacing it — see `mergeIntoDraft`.
   *
   * The seed goes through the pending-prompt channel rather than the
   * `draft:<id>` localStorage key, which reached the composer in neither case:
   * a mounted composer never re-reads storage, and an unsaved chat doesn't read
   * it at all. See `pending-prompt-store.ts`.
   */
  const openChat = useCallback(
    (prompt?: string) => {
      const closed = lastChatRef.current
      const existing = openChatIdRef.current ?? closed?.id ?? null
      if (existing) {
        if (prompt) {
          setPendingPrompt(existing, prompt)
        }
        // Only re-open when it isn't already on screen; reusing the *open* chat
        // must not churn the URL and remount the session under the user.
        //
        // A chat that never got a first message has no row, so it goes back as
        // a draft. Putting an unsaved id in `?chat=` promises a thread that
        // hydration can't find and bounces the user to Not Found — the reason
        // drafts stay out of the URL in the first place.
        if (!openChatIdRef.current) {
          showChat(existing, closed?.persisted === true)
        }
        return
      }
      const id = uuidv7()
      if (prompt) {
        setPendingPrompt(id, prompt)
      }
      showChat(id, false)
    },
    [showChat],
  )

  /*
   * Closing the panel hides the conversation; it doesn't end it.
   *
   * Both ids were simply cleared, so reopening minted a fresh thread and the
   * conversation you had just been having was reachable only through the
   * history menu. "Close" on a panel means put it away — the next open resumes
   * where you left off, which is what every other panel in the app does.
   */
  const closeChat = useCallback(() => {
    const closing = openChatIdRef.current
    lastChatRef.current = closing
      ? { id: closing, persisted: isPersisted(closing, draftChatIdRef.current !== null) }
      : null
    setDraftChatId(null)
    setOpenChatParam(null)
  }, [setOpenChatParam])

  /**
   * Promote highlighted passages into the composer as quote chips.
   *
   * Reuses the quote-reply channel (`pending-quotes-store`) that the "Reply"
   * button on an assistant message already uses: same chip, same removal
   * affordance, and on send the passage becomes a real quote part rather than
   * string-concatenated into the user's text. Keyed by thread id, so the chat
   * session must exist first — when the panel is closed we mint the session and
   * attach in the same tick, because the store is keyed, not ordered, and
   * doesn't care that the chat has yet to mount.
   */
  const attachToComposer = useCallback(
    (passages: string[]) => {
      /*
       * Resumes a closed conversation rather than starting a new one, for the same
       * reason `openChat` does — and it has to agree with `openChat`, or the two
       * ways into this panel disagree about whether closing ended the chat. It
       * used to mint a fresh id whenever the panel was shut, quietly abandoning
       * the conversation the user had just been having.
       */
      const closed = lastChatRef.current
      const threadId = openChatIdRef.current ?? closed?.id ?? uuidv7()
      if (!openChatIdRef.current) {
        showChat(threadId, closed?.persisted === true)
      }
      const { addQuote } = usePendingQuotesStore.getState()
      for (const text of passages) {
        addQuote(threadId, { text })
      }
    },
    [showChat],
  )

  return {
    openChatId,
    draftChatId,
    openChat,
    openExistingChat: showPersistedChat,
    closeChat,
    attachToComposer,
    handleChatCreated,
  }
}
