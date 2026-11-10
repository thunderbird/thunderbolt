/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { normalizeBrowserUrl } from './browser-url'
import type { SidebarBrowserState, SidebarWebviewConfig } from './use-sidebar-webview'

export type BrowserTab = {
  id: string
  config: SidebarWebviewConfig
  url: string
  title: string
  faviconUrls?: string[]
  isLoading: boolean
  focusAddress: boolean
  closedAt: number | null
}

type BrowserTabsState = {
  tabs: BrowserTab[]
  activeId: string
  requestedConfig: SidebarWebviewConfig
}

type BrowserTabsAction =
  | { type: 'open'; tab: BrowserTab; requestedConfig?: SidebarWebviewConfig }
  | { type: 'select'; id: string; requestedConfig?: SidebarWebviewConfig }
  | { type: 'cycle'; direction: 1 | -1 }
  | { type: 'close'; id: string; closedAt: number }
  | { type: 'close-all'; closedAt: number }
  | { type: 'update'; id: string; page: SidebarBrowserState }

/** Create an independent native session; navigating it never changes its initial config. */
const createTab = (url: string, focusAddress = false): BrowserTab => ({
  id: crypto.randomUUID(),
  config: { url },
  url,
  title: '',
  isLoading: true,
  focusAddress,
  closedAt: null,
})

/** Keep tab selection valid when background tabs close or native updates arrive late. */
const browserTabsReducer = (state: BrowserTabsState, action: BrowserTabsAction): BrowserTabsState => {
  const openTabs = state.tabs.filter((tab) => tab.closedAt === null)
  switch (action.type) {
    case 'open':
      return {
        tabs: [...state.tabs, action.tab],
        activeId: action.tab.id,
        requestedConfig: action.requestedConfig ?? state.requestedConfig,
      }
    case 'select':
      return openTabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id, requestedConfig: action.requestedConfig ?? state.requestedConfig }
        : state
    case 'cycle': {
      if (!openTabs.length) {
        return state
      }
      const index = openTabs.findIndex((tab) => tab.id === state.activeId)
      return { ...state, activeId: openTabs[(index + action.direction + openTabs.length) % openTabs.length].id }
    }
    case 'close': {
      const index = openTabs.findIndex((tab) => tab.id === action.id)
      if (index === -1) {
        return state
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.id === action.id ? { ...tab, closedAt: action.closedAt } : tab)),
        activeId:
          state.activeId === action.id ? (openTabs[index + 1]?.id ?? openTabs[index - 1]?.id ?? '') : state.activeId,
      }
    }
    case 'update': {
      const tab = openTabs.find((tab) => tab.id === action.id)
      if (
        !tab ||
        (tab.url === action.page.url &&
          tab.title === action.page.title &&
          tab.isLoading === action.page.isLoading &&
          JSON.stringify(tab.faviconUrls) === JSON.stringify(action.page.faviconUrls))
      ) {
        return state
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.id
            ? {
                ...tab,
                url: action.page.url,
                title: action.page.title,
                faviconUrls: action.page.faviconUrls,
                isLoading: action.page.isLoading,
              }
            : tab,
        ),
      }
    }
    case 'close-all':
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({ ...tab, closedAt: tab.closedAt ?? action.closedAt })),
        activeId: '',
      }
  }
}

/** Own open tabs independently of each tab's native history and address edits. */
export const useBrowserTabs = (config: SidebarWebviewConfig) => {
  const [state, dispatch] = useReducer(browserTabsReducer, config, (requestedConfig) => {
    const tab = createTab(requestedConfig.url)
    return { tabs: [tab], activeId: tab.id, requestedConfig }
  })
  // The sidebar browser button reuses a blank tab; explicit +/keyboard actions
  // still create a new tab. Links from chat keep opening independent pages.
  if (state.requestedConfig !== config) {
    const blankTabs = state.tabs.filter((tab) => tab.closedAt === null && tab.url === 'about:blank')
    const reusableTab = blankTabs.find((tab) => tab.id === state.activeId) ?? blankTabs[0]
    if (config.url === 'about:blank' && reusableTab) {
      dispatch({ type: 'select', id: reusableTab.id, requestedConfig: config })
    } else {
      dispatch({ type: 'open', tab: createTab(config.url), requestedConfig: config })
    }
  }

  return {
    tabs: state.tabs.filter((tab) => tab.closedAt === null),
    activeId: state.activeId,
    openTab: (url?: string, options?: { focusAddress?: boolean }) => {
      const target = url ? normalizeBrowserUrl(url) : 'about:blank'
      if (target) {
        const tab = createTab(target, options?.focusAddress ?? !url)
        dispatch({ type: 'open', tab })
        return tab.id
      }
    },
    selectTab: (id: string) => dispatch({ type: 'select', id }),
    closeTab: (id: string) => dispatch({ type: 'close', id, closedAt: Date.now() }),
    closeAll: () => dispatch({ type: 'close-all', closedAt: Date.now() }),
    cycleTab: (direction: 1 | -1) => dispatch({ type: 'cycle', direction }),
    updateTab: (id: string, page: SidebarBrowserState) => dispatch({ type: 'update', id, page }),
  }
}
