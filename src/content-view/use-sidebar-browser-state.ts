/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { trackEvent } from '@/lib/posthog'
import { normalizeBrowserUrl } from './browser-url'
import { useBrowserShortcuts } from './use-browser-shortcuts'
import { useSidebarWebview, type SidebarBrowserState, type SidebarWebviewConfig } from './use-sidebar-webview'

/** Connect browser chrome, native navigation, and shortcuts. */
export const useSidebarBrowserState = ({
  tabId,
  config,
  onClose,
  hidden,
  focusAddress,
  onStateChange,
  onNewTab,
  onCloseTab,
  onNextTab,
  onPreviousTab,
}: {
  tabId: string
  config: SidebarWebviewConfig | null
  onClose?: () => void
  hidden?: boolean
  focusAddress: boolean
  onStateChange: (state: SidebarBrowserState) => void
  onNewTab: (url?: string) => void
  onCloseTab: () => void
  onNextTab: () => void
  onPreviousTab: () => void
}) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const browser = useSidebarWebview(config, viewportRef, hidden, { tabId, onStateChange, onNewTab })
  const [actionError, setActionError] = useState(false)
  const { copy, isCopied } = useCopyToClipboard()
  const currentUrl = normalizeBrowserUrl(browser.url)
  const handleClose = () => {
    trackEvent('preview_close')
    onClose?.()
  }
  const handleCopy = async () => {
    try {
      await copy(browser.url)
      setActionError(false)
      trackEvent('preview_copy_url')
    } catch {
      setActionError(true)
    }
  }
  const handleOpenExternal = async () => {
    if (!currentUrl) {
      return
    }
    try {
      await openUrl(currentUrl)
      setActionError(false)
      trackEvent('preview_open_external')
    } catch {
      setActionError(true)
    }
  }
  useBrowserShortcuts({
    browser,
    addressRef,
    hidden: hidden ?? false,
    onNewTab,
    onCloseTab,
    onNextTab,
    onPreviousTab,
  })

  const focusedAddress = useRef(false)
  useEffect(() => {
    if (focusAddress && !focusedAddress.current && browser.isInitialized && !hidden) {
      focusedAddress.current = true
      addressRef.current?.focus()
      addressRef.current?.select()
    }
  }, [focusAddress, browser.isInitialized, hidden])

  return {
    browser,
    viewportRef,
    addressRef,
    actionError,
    isCopied,
    currentUrl,
    handleClose,
    handleCopy,
    handleOpenExternal,
  }
}
