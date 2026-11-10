/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import { useBrowserShortcuts } from '@/content-view/use-browser-shortcuts'
import { useMutation } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import type { PageChrome, PageNavigation } from '@shared/page-protocol'
import { isTauri } from '@/lib/platform'
import { pageController } from './page-controller'
import { openUrlPage, usePageStore, type PageSession } from './page-store'
import { useSavePage, useSavedPages } from './use-saved-pages'
import { pageDefinitionForPin } from './page-display'
import { pagePath } from './page-path'
import { usePagePicker } from './use-page-picker'

export const usePagePanelState = ({
  sessionId,
  mode = 'sidebar',
  onClose,
  onRestore,
  hidden = false,
}: {
  sessionId?: string
  mode?: 'sidebar' | 'expanded'
  onClose: () => void
  onRestore?: () => void
  hidden?: boolean
}) => {
  const sessions = usePageStore((state) => state.sessions)
  const activeId = usePageStore((state) => state.activeId)
  const tabs = sessions.filter((session) => session.presentation !== 'inline')
  const session = sessions.find((session) => session.id === (sessionId ?? activeId))
  const addressRef = useRef<HTMLInputElement>(null)
  const { pages } = useSavedPages()
  const pin = useSavePage()
  const picker = usePagePicker(session)
  const location = useLocation()
  const navigate = useNavigate()
  const select = (id: string) => {
    if (mode === 'expanded') {
      const next = sessions.find((item) => item.id === id)
      if (next) {
        usePageStore.getState().present(id, 'expanded')
        navigate(pagePath(next.page.id), { replace: true, state: location.state })
      }
    } else {
      usePageStore.getState().present(id, 'sidebar')
    }
  }
  const newTab = () => {
    const id = openUrlPage()
    if (mode === 'expanded') {
      const next = usePageStore.getState().sessions.find((item) => item.id === id)!
      usePageStore.getState().present(id, 'expanded')
      navigate(pagePath(next.page.id), { replace: true, state: location.state })
    }
    requestAnimationFrame(() => {
      addressRef.current?.focus()
      addressRef.current?.select()
    })
  }
  const closeTab = (id: string) => {
    const next = tabs.find((item) => item.id !== id)
    usePageStore.getState().close(id)
    if (!next) {
      onClose()
    } else if (id === session?.id) {
      select(next.id)
    }
  }
  const navigation = useMutation({
    mutationFn: async (action: PageNavigation) => {
      if (!session) {
        return false
      }
      if (!isTauri() && session.page.source.kind === 'url' && action.type === 'navigate') {
        usePageStore.getState().update(session.id, {
          browser: { ...session.browser, url: action.url, title: URL.parse(action.url)?.hostname ?? '' },
          error: null,
        })
        return true
      }
      const adapter = await pageController.adapter(session.id)
      if (!adapter.navigate) {
        throw new Error('Page navigation is unavailable.')
      }
      await adapter.navigate(action)
      return true
    },
  })
  const runNavigation = async (action: PageNavigation) => {
    try {
      return await navigation.mutateAsync(action)
    } catch {
      return false
    }
  }
  const pinPage = async (target: PageSession, chrome: PageChrome) => {
    try {
      await pin.save({ page: pageDefinitionForPin(target), chrome })
    } catch {
      /* Mutation exposes the save error below. */
    }
  }
  const unpin = async (id: string) => {
    try {
      await pin.remove(id)
    } catch {
      /* Mutation exposes the save error below. */
    }
  }
  const expand = () => {
    if (session) {
      onClose()
      usePageStore.getState().present(session.id, 'expanded')
      navigate(pagePath(session.page.id), { state: { returnTo: location.pathname + location.search } })
    }
  }
  useBrowserShortcuts({
    browser: {
      webview: session?.nativeLabel ? { label: session.nativeLabel } : null,
      isInitialized: Boolean(session?.nativeLabel),
      canGoBack: session?.browser.canGoBack ?? false,
      canGoForward: session?.browser.canGoForward ?? false,
      reload: async () => {
        return runNavigation({ type: 'reload' })
      },
      goBack: async () => {
        return runNavigation({ type: 'back' })
      },
      goForward: async () => {
        return runNavigation({ type: 'forward' })
      },
    },
    addressRef,
    hidden,
    onNewTab: newTab,
    onCloseTab: () => {
      if (session) {
        closeTab(session.id)
      }
    },
    onNextTab: () => {
      const index = tabs.findIndex((tab) => tab.id === session?.id)
      const next = tabs[(index + 1) % tabs.length]
      if (next) {
        select(next.id)
      }
    },
    onPreviousTab: () => {
      const index = tabs.findIndex((tab) => tab.id === session?.id)
      const next = tabs[(index - 1 + tabs.length) % tabs.length]
      if (next) {
        select(next.id)
      }
    },
  })
  return {
    session,
    tabs,
    addressRef,
    picker,
    pinnedIds: new Set(pages.map((page) => page.id)),
    select,
    newTab,
    closeTab,
    pinPage,
    unpin,
    runNavigation,
    expand,
    onRestore,
    error: pin.error || navigation.error,
    busy: navigation.isPending,
  }
}
