/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { useChatStore } from '@/chats/chat-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { pageController, type PageAdapter } from './page-controller'
import { usePageStore } from './page-store'
import { usePagePicker } from './use-page-picker'

const selection = {
  url: 'https://example.com',
  title: 'Example',
  element: {
    id: 'document:element',
    label: 'Example button',
    text: 'Click here',
    rect: { x: 10, y: 20, width: 50, height: 30 },
  },
}
const disposals: (() => void)[] = []
let previousChat: string | null
beforeEach(() => {
  previousChat = useChatStore.getState().currentSessionId
  useChatStore.setState({ currentSessionId: 'chat-one' })
  usePendingQuotesStore.setState({ quotesByThread: {} })
})
afterEach(() => {
  cleanup()
  disposals.splice(0).forEach((dispose) => dispose())
  useChatStore.setState({ currentSessionId: previousChat })
  usePendingQuotesStore.setState({ quotesByThread: {} })
})

const setup = (poll: () => Promise<unknown> = async () => selection) => {
  const id = usePageStore
    .getState()
    .ensure({ id: crypto.randomUUID(), title: 'Page', source: { kind: 'html', html: '<button>Click</button>' } })
  const picker = mock(async (_enabled: boolean, _requestId: string) => {})
  const pollPicker = mock(poll)
  const adapter: PageAdapter = {
    capabilities: {
      observe: true,
      selectElement: true,
      navigate: false,
      screenshot: false,
      declaredTools: false,
      pointerInput: 'synthetic',
      keyboardInput: 'synthetic',
    },
    snapshot: async () => {
      throw new Error('Not used')
    },
    picker,
    pollPicker,
  }
  disposals.push(pageController.register(id, adapter))
  const session = usePageStore.getState().sessions.find((session) => session.id === id)!
  return {
    ...renderHook(({ session }) => usePagePicker(session), { initialProps: { session } }),
    picker,
    pollPicker,
    session,
  }
}

describe('page element selection', () => {
  it('attaches a bounded page/session reference to the chat that initiated the gesture', async () => {
    const { result, session, picker } = setup()
    await act(async () => result.current.toggle())
    const quote = usePendingQuotesStore.getState().quotesByThread['chat-one'][0].data.text
    expect(quote).toContain('Example button\nClick here')
    expect(quote).toContain(`"sessionId":"${session.id}"`)
    expect(quote).toContain(`"pageId":"${session.page.id}"`)
    expect(quote).toContain('"elementRef":"document:element"')
    expect(result.current.isPicking).toBe(false)
    expect(picker.mock.calls.map(([enabled]) => enabled)).toEqual([true, false])
  })

  it.each(['chat', 'navigation', 'unmount'] as const)(
    'discards a late pick after %s changes its scope',
    async (change) => {
      const reply = Promise.withResolvers<unknown>()
      const { result, session, rerender, unmount } = setup(() => reply.promise)
      await act(async () => result.current.toggle())
      act(() => {
        if (change === 'chat') {
          useChatStore.setState({ currentSessionId: 'chat-two' })
        } else if (change === 'navigation') {
          rerender({ session: { ...session, browser: { ...session.browser, url: 'https://next.example' } } })
        } else {
          unmount()
        }
      })
      await act(async () => {
        reply.resolve(selection)
      })
      expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
    },
  )

  it('stops polling on Escape without delivering a quote', async () => {
    const { result, picker, pollPicker } = setup(async () => null)
    await act(async () => result.current.toggle())
    expect(result.current.isPicking).toBe(true)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(result.current.isPicking).toBe(false)
    expect(pollPicker).toHaveBeenCalledTimes(1)
    expect(picker.mock.calls.map(([enabled]) => enabled)).toEqual([true, false])
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
  })

  it('rejects malformed page replies without inserting unvalidated composer data', async () => {
    const { result } = setup(async () => ({ ...selection, element: { ...selection.element, rect: { x: NaN } } }))
    await act(async () => result.current.toggle())
    expect(result.current.error).toBe(true)
    expect(result.current.isPicking).toBe(false)
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
  })
})
