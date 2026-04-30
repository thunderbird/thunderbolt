/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { isTauri } from '@/lib/platform'
import { trackEvent } from '@/lib/posthog'
import { isSafeUrl } from '@/lib/url-utils'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useRef } from 'react'
import { ContentViewHeader } from './header'
import { useSidebarWebview, type SidebarWebviewConfig } from './use-sidebar-webview'

type SidebarWebviewProps = {
  config: SidebarWebviewConfig | null
  onClose?: () => void
  hidden?: boolean
}

/**
 * Component that displays a webview filling a sidebar container
 *
 * The webview will automatically track the container's size and position,
 * updating when the sidebar is resized or moved.
 */
export const SidebarWebview = ({ config, onClose, hidden }: SidebarWebviewProps) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const { isInitialized, closeWebview } = useSidebarWebview(config, panelRef, hidden)
  const { copy, isCopied } = useCopyToClipboard()

  const handleClose = async () => {
    try {
      trackEvent('preview_close')
      await closeWebview()
      onClose?.()
    } catch (error) {
      console.error('Error closing sidebar webview:', error)
    }
  }

  const handleCopyUrl = async () => {
    if (!config?.url) {
      return
    }
    await copy(config.url)
    trackEvent('preview_copy_url')
  }

  const handleOpenExternal = async () => {
    if (!config?.url || !isSafeUrl(config.url)) {
      return
    }

    trackEvent('preview_open_external')
    await openUrl(config.url)
  }

  if (!isTauri()) {
    return (
      <div className="flex flex-col h-full">
        <ContentViewHeader title="Preview" onClose={() => onClose?.()} className="border-b border-border" />
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <p className="text-muted-foreground text-sm">Preview webview is only available in the desktop app</p>
        </div>
      </div>
    )
  }

  if (!config) {
    return null
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full w-full">
      <ContentViewHeader
        title={config.url}
        onClose={handleClose}
        className="border-b border-border bg-background z-10"
        actions={
          <>
            <Button
              onClick={handleCopyUrl}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              title="Copy URL"
            >
              {isCopied ? <Check className="size-4 animate-[fadeOut_2s_ease-in-out]" /> : <Copy className="size-4" />}
            </Button>
            <Button
              onClick={handleOpenExternal}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              title="Open in browser"
            >
              <ExternalLink className="size-4" />
            </Button>
          </>
        }
      />

      {/* Spacer for webview - this will be covered by the webview */}
      <div className="flex-1 w-full bg-background relative">
        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-muted-foreground text-sm">Loading preview...</p>
          </div>
        )}
      </div>
    </div>
  )
}
