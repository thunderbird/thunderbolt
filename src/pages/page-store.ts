/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import type { PageChrome, PageDefinition, PagePresentation } from '@shared/page-protocol'
import type { SidebarBrowserState } from '@/content-view/use-sidebar-webview'

export type PageSession = {
  id: string
  page: PageDefinition
  chrome: PageChrome
  presentation: PagePresentation
  browser: SidebarBrowserState
  height: number
  error: string | null
  nativeLabel?: string
  chatThreadId: string | null
}
type PageStore = {
  sessions: PageSession[]
  activeId: string | null
  ensure: (
    page: PageDefinition,
    options?: { chrome?: PageChrome; presentation?: PagePresentation; chatThreadId?: string | null },
  ) => string
  replacePage: (id: string, page: PageDefinition) => void
  present: (id: string, mode: PagePresentation) => void
  close: (id: string) => void
  update: (
    id: string,
    patch: Partial<Pick<PageSession, 'browser' | 'height' | 'error' | 'chrome' | 'nativeLabel'>>,
  ) => void
}

/** Live documents outlive routes and display slots; only closing a page destroys its session. */
export const usePageStore = create<PageStore>((set, get) => ({
  sessions: [],
  activeId: null,
  ensure: (page, options = {}) => {
    const existing = get().sessions.find((session) => session.page.id === page.id)
    if (existing) {
      return existing.id
    }
    const id = crypto.randomUUID()
    const session: PageSession = {
      id,
      page,
      chrome: options.chrome ?? 'browser',
      presentation: options.presentation ?? 'sidebar',
      browser: {
        url: page.source.kind === 'url' ? page.source.url : '',
        title: page.title,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
      height: 400,
      error: null,
      chatThreadId: options.chatThreadId ?? null,
    }
    set((state) => ({
      sessions: [...state.sessions, session],
      activeId: session.presentation === 'inline' ? state.activeId : id,
    }))
    return id
  },
  replacePage: (id, page) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              page,
              error:
                session.page.source.kind === 'html' &&
                page.source.kind === 'html' &&
                session.page.source.html === page.source.html
                  ? session.error
                  : null,
              browser: { ...session.browser, title: page.title },
            }
          : session,
      ),
    })),
  present: (id, presentation) =>
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === id ? { ...session, presentation } : session)),
      activeId:
        presentation === 'inline'
          ? state.activeId === id
            ? (state.sessions.find((s) => s.id !== id && s.presentation !== 'inline')?.id ?? null)
            : state.activeId
          : id,
    })),
  close: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      activeId:
        state.activeId === id
          ? (state.sessions.find((session) => session.id !== id && session.presentation !== 'inline')?.id ?? null)
          : state.activeId,
    })),
  update: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
    })),
}))

/** New user-created tabs are independent; the panel toggle may reuse an existing blank page. */
export const openUrlPage = (url = 'about:blank', reuseBlank = false) => {
  const state = usePageStore.getState()
  const existing =
    reuseBlank && url === 'about:blank'
      ? state.sessions.find((session) => session.page.source.kind === 'url' && session.browser.url === 'about:blank')
      : undefined
  const id = existing?.id ?? state.ensure({ id: crypto.randomUUID(), title: '', source: { kind: 'url', url } })
  state.present(id, 'sidebar')
  return id
}
