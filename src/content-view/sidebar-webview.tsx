import { Button } from '@/components/ui/button'
import { isTauri } from '@/lib/platform'
import { trackEvent } from '@/lib/posthog'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useRef, useState } from 'react'
import { ContentViewHeader } from './header'
import { useSidebarWebview, type SidebarWebviewConfig } from './use-sidebar-webview'

type SidebarWebviewProps = {
  config: SidebarWebviewConfig | null
  onClose?: () => void
}

/**
 * Component that displays a webview filling a sidebar container
 *
 * The webview will automatically track the container's size and position,
 * updating when the sidebar is resized or moved.
 */
export const SidebarWebview = ({ config, onClose }: SidebarWebviewProps) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const { isInitialized, closeWebview } = useSidebarWebview(config, panelRef)
  const [isCopied, setIsCopied] = useState(false)

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
    if (!config?.url) return
    try {
      await navigator.clipboard.writeText(config.url)
      trackEvent('preview_copy_url')
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (error) {
      console.error('Error copying URL:', error)
    }
  }

  const handleOpenExternal = async () => {
    if (!config?.url) return
    try {
      trackEvent('preview_open_external')
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(config.url)
    } catch (error) {
      console.error('Error opening URL externally:', error)
    }
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
      {/* Header matching main app header - 48px tall */}
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
        {/* Loading state */}
        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-muted-foreground text-sm">Loading preview...</p>
          </div>
        )}
      </div>
    </div>
  )
}
