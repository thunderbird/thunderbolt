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
 *
 * @example
 * ```tsx
 * const [webviewConfig, setWebviewConfig] = useState<SidebarWebviewConfig | null>(null)
 *
 * // When user clicks a preview link:
 * setWebviewConfig({ url: 'https://example.com' })
 *
 * // Render in sidebar:
 * <SidebarWebview
 *   config={webviewConfig}
 *   onClose={() => setWebviewConfig(null)}
 * />
 * ```
 */
export const SidebarWebview = ({ config, onClose }: SidebarWebviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { isInitialized, closeWebview } = useSidebarWebview(config, containerRef)

  if (!isTauri()) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-center">
        <p className="text-muted-foreground text-sm">Preview webview is only available in the desktop app</p>
      </div>
    )
  }

  if (!config) {
    return null
  }

  const handleClose = async () => {
    await closeWebview()
    onClose?.()
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-background">
      {/* Close button overlay */}
      <div className="absolute top-2 right-2 z-50">
        <Button
          variant="secondary"
          size="icon"
          className="h-8 w-8 shadow-lg"
          onClick={handleClose}
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Loading state */}
      {!isInitialized && (
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground text-sm">Loading preview...</p>
        </div>
      )}

      {/* The webview will overlay this container */}
      {isInitialized && (
        <div className="absolute inset-0 pointer-events-none">
          <p className="text-xs text-muted-foreground p-2">Webview active</p>
        </div>
      )}
    </div>
  )
}
