import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Webview, type WebviewOptions } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'

export type SidebarWebviewConfig = {
  url: string
  onClose?: () => void
}

type WebviewState = {
  webview: Webview | null
  isInitialized: boolean
}

/**
 * Hook to manage a single webview positioned in a sidebar container
 *
 * This tracks the sidebar's DOM element and creates a webview that fills it.
 * The webview automatically resizes when the sidebar dimensions change.
 */
export const useSidebarWebview = (
  config: SidebarWebviewConfig | null,
  containerRef: React.RefObject<HTMLElement | null>,
) => {
  const [webviewState, setWebviewState] = useState<WebviewState>({
    webview: null,
    isInitialized: false,
  })
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const updateTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const windowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  useEffect(() => {
    if (!config || !containerRef.current) {
      return
    }

    let webview: Webview | null = null
    let isActive = true

    const initWebview = async () => {
      try {
        windowRef.current = getCurrentWindow()
        const container = containerRef.current
        if (!container || !isActive) return

        // Get container position relative to window
        const rect = container.getBoundingClientRect()

        const webviewOptions: WebviewOptions = {
          url: config.url,
          x: Math.floor(rect.left),
          y: Math.floor(rect.top),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        }

        const webviewLabel = `sidebar-webview-${Date.now()}`
        console.log('Creating webview:', webviewLabel, webviewOptions)

        webview = new Webview(windowRef.current, webviewLabel, webviewOptions)

        // Listen for webview creation success
        webview.once('tauri://created', () => {
          console.log('Webview created successfully:', webviewLabel)
        })

        webview.once('tauri://error', (error) => {
          console.error('Webview creation error:', error)
        })

        if (!isActive) {
          // Component unmounted while we were creating the webview
          webview.close().catch(console.error)
          return
        }

        setWebviewState({
          webview,
          isInitialized: true,
        })

        // Set up ResizeObserver to track container size changes
        resizeObserverRef.current = new ResizeObserver(() => {
          if (updateTimeoutRef.current) {
            clearTimeout(updateTimeoutRef.current)
          }

          updateTimeoutRef.current = setTimeout(async () => {
            // Check if webview is still valid
            if (!webview || !containerRef.current || !isActive) return

            const newRect = containerRef.current.getBoundingClientRect()

            try {
              await webview.setPosition(new LogicalPosition(Math.floor(newRect.left), Math.floor(newRect.top)))
              await webview.setSize(new LogicalSize(Math.floor(newRect.width), Math.floor(newRect.height)))
            } catch (error) {
              // Silently ignore errors if webview was closed
              if (isActive) {
                console.error('Failed to update webview position/size:', error)
              }
            }
          }, 50) // 50ms debounce
        })

        if (container) {
          resizeObserverRef.current.observe(container)
        }
      } catch (error) {
        console.error('Failed to initialize sidebar webview:', error)
      }
    }

    initWebview()

    // Cleanup
    return () => {
      isActive = false
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
      if (webview) {
        webview.close().catch(console.error)
      }
    }
  }, [config?.url]) // Re-initialize if URL changes

  const closeWebview = async () => {
    if (webviewState.webview) {
      await webviewState.webview.close()
      setWebviewState({ webview: null, isInitialized: false })
      config?.onClose?.()
    }
  }

  return {
    ...webviewState,
    closeWebview,
  }
}
