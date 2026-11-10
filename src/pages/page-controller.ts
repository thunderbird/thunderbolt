/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageAction, PageCapabilities, PageDefinition, PageNavigation, PageSnapshot } from '@shared/page-protocol'
import { pageSlots } from './page-slot'
import { usePageStore } from './page-store'

export type PageAdapter = {
  capabilities: PageCapabilities
  present?: (signal?: AbortSignal) => Promise<void>
  snapshot: (
    screenshot: boolean,
    signal?: AbortSignal,
  ) => Promise<Omit<PageSnapshot, 'pageId' | 'sessionId' | 'capabilities'>>
  navigate?: (navigation: PageNavigation) => Promise<void>
  act?: (action: PageAction, signal?: AbortSignal) => Promise<void>
  picker?: (enabled: boolean, requestId: string) => Promise<void>
  pollPicker?: (requestId: string) => Promise<unknown>
}
const adapters = new Map<string, PageAdapter>()
let reveal: (() => void) | undefined
let sequence: Promise<unknown> = Promise.resolve()
const requireSession = (id: string) => {
  const session = usePageStore.getState().sessions.find((session) => session.id === id)
  if (!session) {
    throw new Error('Page session is closed. List pages again.')
  }
  return session
}
/** A transport-neutral controller routes operations to the exact live document adapter. */
export const pageController = {
  register: (id: string, adapter: PageAdapter) => {
    adapters.set(id, adapter)
    return () => {
      if (adapters.get(id) === adapter) {
        adapters.delete(id)
      }
    }
  },
  registerReveal: (callback: () => void) => {
    reveal = callback
    return () => {
      if (reveal === callback) {
        reveal = undefined
      }
    }
  },
  list: () =>
    usePageStore.getState().sessions.map((session) => ({
      sessionId: session.id,
      pageId: session.page.id,
      title: session.browser.title || session.page.title,
      url: session.browser.url,
      source: session.page.source.kind,
      presentation: session.presentation,
      capabilities: adapters.get(session.id)?.capabilities ?? null,
    })),
  open: (page: PageDefinition) => {
    const id = usePageStore.getState().ensure(page)
    usePageStore.getState().present(id, 'sidebar')
    reveal?.()
    return id
  },
  select: (id: string) => {
    requireSession(id)
    usePageStore.getState().present(id, 'sidebar')
    reveal?.()
  },
  close: (id: string) => {
    requireSession(id)
    adapters.delete(id)
    usePageStore.getState().close(id)
  },
  activate: (id: string) => {
    const session = requireSession(id)
    const slot = pageSlots.get(id, session.presentation)?.element
    if (!slot?.isConnected || !slot.getClientRects().length) {
      pageController.select(id)
    } else {
      if (session.presentation !== 'inline' && usePageStore.getState().activeId !== id) {
        usePageStore.getState().present(id, session.presentation)
      }
      slot.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    pageSlots.notify()
  },
  adapter: async (id: string, signal?: AbortSignal) => {
    requireSession(id)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      requireSession(id)
      const adapter = adapters.get(id)
      if (adapter) {
        return adapter
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Page is not ready or cannot be embedded on this platform.')
  },
  snapshot: async (id: string, screenshot = false, signal?: AbortSignal): Promise<PageSnapshot> => {
    const session = requireSession(id)
    const adapter = await pageController.adapter(id, signal)
    if (!adapter.capabilities.observe) {
      throw new Error('This page does not support observations.')
    }
    if (screenshot && !adapter.capabilities.screenshot) {
      throw new Error('Screenshots are unavailable for this page.')
    }
    pageController.activate(id)
    await adapter.present?.(signal)
    signal?.throwIfAborted()
    requireSession(id)
    if (adapters.get(id) !== adapter) {
      throw new Error('The document changed while presenting it. Observe again.')
    }
    const result = await adapter.snapshot(screenshot, signal)
    signal?.throwIfAborted()
    requireSession(id)
    if (adapters.get(id) !== adapter) {
      throw new Error('The document changed while reading it. Observe again.')
    }
    return { ...result, pageId: session.page.id, sessionId: id, capabilities: adapter.capabilities }
  },
  navigate: async (id: string, navigation: PageNavigation, signal?: AbortSignal) => {
    const adapter = await pageController.adapter(id, signal)
    if (!adapter.capabilities.navigate || !adapter.navigate) {
      throw new Error('This page does not support navigation.')
    }
    signal?.throwIfAborted()
    await adapter.navigate(navigation)
    return pageController.snapshot(id, false, signal)
  },
  act: async (id: string, action: PageAction, signal?: AbortSignal) => {
    const pending = sequence
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted()
        const adapter = await pageController.adapter(id, signal)
        const input =
          action.type === 'type' || action.type === 'key'
            ? adapter.capabilities.keyboardInput
            : adapter.capabilities.pointerInput
        if (input === 'none' || !adapter.act) {
          throw new Error('This page does not support that interaction.')
        }
        pageController.activate(id)
        await adapter.present?.(signal)
        signal?.throwIfAborted()
        requireSession(id)
        if (adapters.get(id) !== adapter) {
          throw new Error('The document changed while presenting it. Observe again.')
        }
        await adapter.act(action, signal)
        return pageController.snapshot(id, false, signal)
      })
    sequence = pending
    return pending
  },
}
