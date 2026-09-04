/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The panel's chat lifecycle, driven directly.
 *
 * Every one of these was a data-loss bug, and none of them was reachable from a
 * test while this logic lived inside a 320-line component: reopening a real
 * thread as an empty draft, an app's request to *open* the panel discarding
 * whatever was in it, a close that ended the conversation rather than putting
 * it away.
 *
 * The distinction under test throughout is draft vs persisted. A draft has no
 * row, so it stays in local state — putting an unsaved id in `?chat=` promises
 * hydration a thread it can't find. A persisted thread belongs in the URL so a
 * reload keeps it.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useSearchParams } from 'react-router'

import { useChatStore, type ChatSession } from '@/chats/chat-store'
import { usePendingPromptStore } from '@/chats/pending-prompt-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import type { ChatThread } from '@/types'
import { useMiniAppChatPanelState } from './use-mini-app-chat-panel-state'

/** Only what `isPersisted` reads; the rest of a session is inert here. */
const seedSession = (id: string, chatThread: ChatThread | null) => {
  const session = { id, chatThread } as ChatSession
  useChatStore.setState({ sessions: new Map([[id, session]]), currentSessionId: id })
}

const wrapper =
  (initialUrl: string) =>
  ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[initialUrl]}>{children}</MemoryRouter>

/** The hook plus the search params it writes, so a test can assert the URL. */
const setup = (initialUrl = '/apps/finance-model') =>
  renderHook(
    () => {
      const [searchParams] = useSearchParams()
      return { ...useMiniAppChatPanelState(), chatParam: searchParams.get('chat') }
    },
    { wrapper: wrapper(initialUrl) },
  )

afterEach(() => {
  useChatStore.setState({ sessions: new Map(), currentSessionId: null })
  usePendingPromptStore.setState({ promptsByThread: {} })
  usePendingQuotesStore.setState({ quotesByThread: {} })
})

describe('opening', () => {
  it('starts closed', () => {
    const { result } = setup()

    expect(result.current.openChatId).toBeNull()
    expect(result.current.draftChatId).toBeNull()
  })

  it('opens a draft, keeping the unsaved id out of the URL', () => {
    const { result } = setup()

    act(() => result.current.openChat())

    expect(result.current.draftChatId).not.toBeNull()
    expect(result.current.openChatId).toBe(result.current.draftChatId)
    expect(result.current.chatParam).toBeNull()
  })

  it('seeds the composer when a prompt comes with the request', () => {
    const { result } = setup()

    act(() => result.current.openChat('explain this chart'))

    const id = result.current.openChatId ?? ''
    expect(usePendingPromptStore.getState().promptsByThread[id]).toBe('explain this chart')
  })

  /**
   * `ui/open-chat` arrives unconditionally, so this used to mint a fresh id
   * every time and swap the conversation on screen out for an empty one.
   */
  it('never discards the conversation already on screen', () => {
    const { result } = setup('/apps/finance-model?chat=thread-1')

    act(() => result.current.openChat('and this one'))

    expect(result.current.openChatId).toBe('thread-1')
    expect(result.current.chatParam).toBe('thread-1')
    expect(usePendingPromptStore.getState().promptsByThread['thread-1']).toBe('and this one')
  })
})

describe('reopening after a close', () => {
  /**
   * The cold-load case: the panel was opened from a link, so nothing in this
   * session ever saw it be a draft. Reopening has to put it back in the URL —
   * routing it through `draftChatId` would hydrate an empty conversation over a
   * thread that has messages.
   */
  it('puts a thread opened from the URL back in the URL', () => {
    const { result } = setup('/apps/finance-model?chat=thread-1')

    act(() => result.current.closeChat())
    expect(result.current.openChatId).toBeNull()
    expect(result.current.chatParam).toBeNull()

    act(() => result.current.openChat())

    expect(result.current.chatParam).toBe('thread-1')
    expect(result.current.draftChatId).toBeNull()
  })

  /**
   * The one a `draftChatId === null` check got wrong. A chat started in the
   * panel keeps its local id until its first message persists; after that it
   * has a row, and reopening it as a draft hydrated a fresh empty conversation
   * on top of that row.
   */
  it('treats a draft that has since been saved as persisted', () => {
    const { result } = setup()

    act(() => result.current.openChat())
    const id = result.current.openChatId ?? ''
    // What the first successful send does: the row exists, and the session is
    // told about it.
    seedSession(id, { id } as ChatThread)

    act(() => result.current.closeChat())
    act(() => result.current.openChat())

    expect(result.current.chatParam).toBe(id)
    expect(result.current.draftChatId).toBeNull()
  })

  /** A chat that never got a message still has no row, so it must not go into
   *  the URL — hydration would bounce it to Not Found. */
  it('keeps a chat that was never saved as a draft', () => {
    const { result } = setup()

    act(() => result.current.openChat())
    const id = result.current.openChatId ?? ''
    seedSession(id, null)

    act(() => result.current.closeChat())
    act(() => result.current.openChat())

    expect(result.current.draftChatId).toBe(id)
    expect(result.current.chatParam).toBeNull()
  })

  it('reuses the same conversation rather than starting a new one', () => {
    const { result } = setup('/apps/finance-model?chat=thread-1')

    act(() => result.current.closeChat())
    act(() => result.current.openChat('follow-up'))

    expect(result.current.openChatId).toBe('thread-1')
    expect(usePendingPromptStore.getState().promptsByThread['thread-1']).toBe('follow-up')
  })
})

describe('promotion and history', () => {
  it('moves a chat into the URL once its first message persists', () => {
    const { result } = setup()

    act(() => result.current.openChat())
    const id = result.current.openChatId ?? ''

    act(() => result.current.handleChatCreated(id))

    expect(result.current.chatParam).toBe(id)
    // Cleared, or the chat still counts as a draft and closing it loses the
    // hydration on reopen.
    expect(result.current.draftChatId).toBeNull()
  })

  it('shows a thread picked from history, dropping any draft', () => {
    const { result } = setup()

    act(() => result.current.openChat())
    act(() => result.current.openExistingChat('thread-9'))

    expect(result.current.chatParam).toBe('thread-9')
    expect(result.current.draftChatId).toBeNull()
    expect(result.current.openChatId).toBe('thread-9')
  })
})

describe('attaching a highlighted passage', () => {
  it('attaches to the conversation already open', () => {
    const { result } = setup('/apps/finance-model?chat=thread-1')

    act(() => result.current.attachToComposer(['Q3 revenue: 4,214,000']))

    expect(usePendingQuotesStore.getState().quotesByThread['thread-1']?.[0]?.data.text).toBe('Q3 revenue: 4,214,000')
  })

  /**
   * The two ways into this panel have to agree about whether closing ended the
   * conversation. `openChat` resumes it; this used to mint a fresh draft and
   * quietly abandon it, so a passage picked after a close started a new chat.
   */
  it('resumes the closed conversation rather than starting a new one', () => {
    const { result } = setup('/apps/finance-model?chat=thread-1')

    act(() => result.current.closeChat())
    act(() => result.current.attachToComposer(['Q3 revenue: 4,214,000']))

    expect(result.current.openChatId).toBe('thread-1')
    expect(result.current.chatParam).toBe('thread-1')
    expect(usePendingQuotesStore.getState().quotesByThread['thread-1']?.[0]?.data.text).toBe('Q3 revenue: 4,214,000')
  })

  /** A closed draft has no row, so resuming it must stay out of the URL. */
  it('resumes a closed draft without putting it in the URL', () => {
    const { result } = setup()

    act(() => result.current.openChat())
    const id = result.current.openChatId ?? ''
    seedSession(id, null)
    act(() => result.current.closeChat())
    act(() => result.current.attachToComposer(['a passage']))

    expect(result.current.draftChatId).toBe(id)
    expect(result.current.chatParam).toBeNull()
    expect(usePendingQuotesStore.getState().quotesByThread[id]?.[0]?.data.text).toBe('a passage')
  })

  /** The panel being closed with nothing behind it is not a reason to lose the
   *  passage — it opens a chat and attaches in the same tick. */
  it('mints a chat when nothing has been open', () => {
    const { result } = setup()

    act(() => result.current.attachToComposer(['Q3 revenue: 4,214,000']))

    const id = result.current.draftChatId ?? ''
    expect(id).not.toBe('')
    expect(usePendingQuotesStore.getState().quotesByThread[id]?.[0]?.data.text).toBe('Q3 revenue: 4,214,000')
  })
})
