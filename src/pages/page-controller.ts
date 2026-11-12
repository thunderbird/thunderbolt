/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageAction, PageCapabilities, PageDefinition, PageNavigation, PageSnapshot } from '@shared/page-protocol'
import { pageSlots } from './page-slot'
import { usePageStore, type PageSession } from './page-store'

export type PageAdapter = {
  capabilities: PageCapabilities
  present?: (signal?: AbortSignal) => Promise<void>
  snapshot: (
    screenshot: boolean,
    signal?: AbortSignal,
  ) => Promise<Omit<PageSnapshot, 'pageId' | 'sessionId' | 'capabilities'>>
  navigate?: (navigation: PageNavigation, signal?: AbortSignal) => Promise<void>
  act?: (action: PageAction, signal?: AbortSignal) => Promise<void>
  picker?: (enabled: boolean, requestId: string) => Promise<void>
  pollPicker?: (requestId: string) => Promise<unknown>
}
export type PageOperationOptions = {
  signal?: AbortSignal
  onStart?: () => void
}

const adapters = new Map<string, PageAdapter>()
let reveal: (() => void) | undefined
let presentExpanded: ((session: PageSession | null) => void) | undefined
let sequence: Promise<unknown> = Promise.resolve()
const requireSession = (id: string) => {
  const session = usePageStore.getState().sessions.find((session) => session.id === id)
  if (!session) {
    throw new Error('Page session is closed. List pages again.')
  }
  return session
}

/** Explicit restores bypass the expanded route's presentation handler. */
const showSidebar = (id: string) => {
  requireSession(id)
  usePageStore.getState().present(id, 'sidebar')
  reveal?.()
}
/** Queue the complete operation, including presentation, so another tool cannot move a native surface mid-click. */
const enqueue = <T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  { signal, onStart }: PageOperationOptions = {},
): Promise<T> => {
  const pending = sequence
    .catch(() => {})
    .then(() => {
      signal?.throwIfAborted()
      onStart?.()
      return operation(signal)
    })
  sequence = pending
  return pending
}

/** A response from a disposed/replaced renderer must never become a live document result. */
const assertCurrent = (id: string, adapter: PageAdapter, signal?: AbortSignal) => {
  signal?.throwIfAborted()
  requireSession(id)
  if (adapters.get(id) !== adapter) {
    throw new Error('The document changed while using it. Observe again.')
  }
}

/** Synthetic input reaches page listeners without invoking the browser's privileged default UI. */
const syntheticInputWarning = (action: PageAction): string | undefined => {
  if (action.type === 'key') {
    return 'Synthetic key events were dispatched to the focused element. Browser default behavior (form submission, focus movement, and text editing) is not simulated. Click the submit control to submit a form, or use the type action to change field text.'
  }
  if (action.type === 'click' && action.button === 'right') {
    return 'A synthetic contextmenu event was dispatched to the targeted element. Native browser context menus are not opened.'
  }
}

/** Called inside the operation queue; public snapshots join the queue instead. */
const readSnapshot = async (id: string, screenshot: boolean, signal?: AbortSignal): Promise<PageSnapshot> => {
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
  assertCurrent(id, adapter, signal)
  const result = await adapter.snapshot(screenshot, signal)
  assertCurrent(id, adapter, signal)
  return { ...result, pageId: session.page.id, sessionId: id, capabilities: adapter.capabilities }
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
  /** The mounted expanded route owns navigation when tools open or select another page. */
  registerExpanded: (callback: (session: PageSession | null) => void) => {
    presentExpanded = callback
    return () => {
      if (presentExpanded === callback) {
        presentExpanded = undefined
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
  /** Replace a generated document only on explicit publication; ordinary ensure/open keeps the current revision. */
  publishHtml: (page: PageDefinition, options: { presentation?: 'inline' | 'sidebar'; chatThreadId?: string } = {}) => {
    const existing = usePageStore.getState().sessions.find((session) => session.page.id === page.id)
    if (page.source.kind !== 'html' || (existing && existing.page.source.kind !== 'html')) {
      throw new Error('Generated pages can only replace an HTML page.')
    }
    if (existing) {
      // The frame only renews its channel when HTML changes; metadata-only edits keep its adapter.
      if (existing.page.source.kind === 'html' && existing.page.source.html !== page.source.html) {
        adapters.delete(existing.id)
      }
      usePageStore.getState().replacePage(existing.id, page)
      if (existing.presentation !== 'inline') {
        pageController.select(existing.id)
      }
      return existing.id
    }
    const id = usePageStore.getState().ensure(page, {
      presentation: options.presentation ?? 'sidebar',
      chatThreadId: options.chatThreadId,
    })
    if (options.presentation !== 'inline') {
      pageController.select(id)
    }
    return id
  },
  open: (page: PageDefinition) => {
    const id = usePageStore.getState().ensure(page)
    pageController.select(id)
    return id
  },
  select: (id: string) => {
    const session = requireSession(id)
    if (presentExpanded) {
      presentExpanded(session)
      return
    }
    showSidebar(id)
  },
  restoreToSidebar: (id: string) => {
    showSidebar(id)
    // Navigation commits asynchronously; tools must stop targeting the old route immediately.
    presentExpanded = undefined
  },
  close: (id: string) => {
    requireSession(id)
    const active = usePageStore.getState().activeId === id
    adapters.delete(id)
    usePageStore.getState().close(id)
    if (active && presentExpanded) {
      const state = usePageStore.getState()
      presentExpanded(state.sessions.find((session) => session.id === state.activeId) ?? null)
    }
  },
  /** Agent lifecycle operations share the input queue; user gestures keep the synchronous methods above. */
  openForAgent: (page: PageDefinition, options?: PageOperationOptions & { onOpen?: (id: string) => void }) =>
    enqueue(async () => {
      const id = pageController.open(page)
      options?.onOpen?.(id)
      return id
    }, options),
  selectForAgent: (id: string, options?: PageOperationOptions) =>
    enqueue(async () => pageController.select(id), options),
  closeForAgent: (id: string, options?: PageOperationOptions) => enqueue(async () => pageController.close(id), options),
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
  snapshot: (id: string, screenshot = false, options?: PageOperationOptions): Promise<PageSnapshot> =>
    enqueue((signal) => readSnapshot(id, screenshot, signal), options),
  navigate: (id: string, navigation: PageNavigation, options?: PageOperationOptions): Promise<PageSnapshot> =>
    enqueue(async (signal) => {
      const adapter = await pageController.adapter(id, signal)
      if (!adapter.capabilities.navigate || !adapter.navigate) {
        throw new Error('This page does not support navigation.')
      }
      pageController.activate(id)
      await adapter.present?.(signal)
      assertCurrent(id, adapter, signal)
      await adapter.navigate(navigation, signal)
      assertCurrent(id, adapter, signal)
      return readSnapshot(id, false, signal)
    }, options),
  act: (id: string, action: PageAction, options?: PageOperationOptions): Promise<PageSnapshot> =>
    enqueue(async (signal) => {
      const adapter = await pageController.adapter(id, signal)
      const input =
        action.type === 'type' || action.type === 'key'
          ? adapter.capabilities.keyboardInput
          : adapter.capabilities.pointerInput
      if (input === 'none' || !adapter.act) {
        throw new Error('This page does not support that interaction.')
      }
      if (action.type === 'key' && input === 'synthetic' && action.key.length > 1 && action.key.includes('+')) {
        throw new Error(
          'Modifier chords require a native browser. Use the type action with clear to replace field text.',
        )
      }
      pageController.activate(id)
      await adapter.present?.(signal)
      assertCurrent(id, adapter, signal)
      await adapter.act(action, signal)
      assertCurrent(id, adapter, signal)
      const snapshot = await readSnapshot(id, false, signal)
      const warning = input === 'synthetic' ? syntheticInputWarning(action) : undefined
      if (!warning) {
        return snapshot
      }
      return {
        ...snapshot,
        warnings: [...(snapshot.warnings ?? []), warning],
      }
    }, options),
}
