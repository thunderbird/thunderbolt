/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { type RefObject, useEffect, useEffectEvent } from 'react'
import type { useSidebarWebview } from './use-sidebar-webview'

type BrowserShortcut = {
  label: string
  action: 'focus-address' | 'reload' | 'back' | 'forward' | 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab'
}

type BrowserShortcutsOptions = {
  browser: ReturnType<typeof useSidebarWebview>
  addressRef: RefObject<HTMLInputElement | null>
  hidden?: boolean
  onNewTab: () => void
  onCloseTab: () => void
  onNextTab: () => void
  onPreviousTab: () => void
}

/** Registers native menu accelerators, which receive keys even when the child page owns focus. */
export const useBrowserShortcuts = ({
  browser,
  addressRef,
  hidden,
  onNewTab,
  onCloseTab,
  onNextTab,
  onPreviousTab,
}: BrowserShortcutsOptions) => {
  const { t } = useLingui()
  const label = browser.webview?.label
  const enabled = browser.isInitialized && !hidden
  const browserLabel = t`Browser`
  const focusAddressLabel = t`Focus address bar`
  const reloadLabel = t`Reload page`
  const backLabel = t`Go back`
  const forwardLabel = t`Go forward`
  const newTabLabel = t`New tab`
  const closeTabLabel = t`Close tab`
  const nextTabLabel = t`Next tab`
  const previousTabLabel = t`Previous tab`
  const handleShortcut = useEffectEvent((shortcut: BrowserShortcut) => {
    if (!enabled || shortcut.label !== label) {
      return
    }
    switch (shortcut.action) {
      case 'focus-address':
        addressRef.current?.focus()
        addressRef.current?.select()
        break
      case 'reload':
        void browser.reload()
        break
      case 'back':
        if (browser.canGoBack) {
          void browser.goBack()
        }
        break
      case 'forward':
        if (browser.canGoForward) {
          void browser.goForward()
        }
        break
      case 'new-tab':
        onNewTab()
        break
      case 'close-tab':
        onCloseTab()
        break
      case 'next-tab':
        onNextTab()
        break
      case 'previous-tab':
        onPreviousTab()
        break
    }
  })
  useEffect(() => {
    if (!label) {
      return
    }
    let active = true
    let unlisten: (() => void) | undefined
    const subscribe = async () => {
      try {
        const remove = await listen<BrowserShortcut>('browser-shortcut', (event) => {
          if (active) {
            handleShortcut(event.payload)
          }
        })
        if (active) {
          unlisten = remove
        } else {
          remove()
        }
      } catch (error) {
        console.error('Could not listen for browser shortcuts:', error)
      }
    }
    void subscribe()
    return () => {
      active = false
      unlisten?.()
      // Empty labels are ignored by the native disable-only path.
      void invoke('browser_configure_shortcuts', {
        config: {
          label,
          enabled: false,
          canGoBack: false,
          canGoForward: false,
          labels: {
            browser: '',
            focusAddress: '',
            reload: '',
            back: '',
            forward: '',
            newTab: '',
            closeTab: '',
            nextTab: '',
            previousTab: '',
          },
        },
      }).catch(console.error)
    }
  }, [label])

  useEffect(() => {
    if (!label) {
      return
    }
    void invoke('browser_configure_shortcuts', {
      config: {
        label,
        enabled,
        canGoBack: browser.canGoBack,
        canGoForward: browser.canGoForward,
        labels: {
          browser: browserLabel,
          focusAddress: focusAddressLabel,
          reload: reloadLabel,
          back: backLabel,
          forward: forwardLabel,
          newTab: newTabLabel,
          closeTab: closeTabLabel,
          nextTab: nextTabLabel,
          previousTab: previousTabLabel,
        },
      },
    }).catch(console.error)
  }, [
    label,
    enabled,
    browser.canGoBack,
    browser.canGoForward,
    browserLabel,
    focusAddressLabel,
    reloadLabel,
    backLabel,
    forwardLabel,
    newTabLabel,
    closeTabLabel,
    nextTabLabel,
    previousTabLabel,
  ])
}
