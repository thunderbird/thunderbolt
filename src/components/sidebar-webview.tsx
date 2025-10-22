import { useSidebarWebview, type SidebarWebviewConfig } from '@/hooks/use-sidebar-webview'
import { isTauri } from '@/lib/platform'
import { X } from 'lucide-react'
import { useRef } from 'react'
import { Button } from './ui/button'

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

  if (!isTauri()) {
    return (
      <div className="flex flex-col h-full">
        <header className="flex h-12 w-full items-center justify-between px-4 flex-shrink-0 border-b border-border">
          <span className="text-sm font-medium">Preview</span>
        </header>
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <p className="text-muted-foreground text-sm">Preview webview is only available in the desktop app</p>
        </div>
      </div>
    )
  }

  if (!config) {
    return null
  }

  const handleClose = async () => {
    console.log('SidebarWebview: Close button clicked')
    try {
      await closeWebview()
      console.log('SidebarWebview: Webview closed')
      onClose?.()
      console.log('SidebarWebview: onClose callback called')
    } catch (error) {
      console.error('SidebarWebview: Error during close:', error)
    }
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full w-full">
      {/* Header matching main app header - 48px tall */}
      <header className="flex h-12 w-full items-center justify-between px-4 flex-shrink-0 border-b border-border bg-background z-10">
        <span className="text-sm font-medium truncate">Preview</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 cursor-pointer flex-shrink-0"
          onClick={handleClose}
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

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
