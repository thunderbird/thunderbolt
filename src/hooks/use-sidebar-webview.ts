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
 * The webview automatically resizes when the sidebar dimensions change and
 * repositions when the window moves.
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
  const animationFrameRef = useRef<number | undefined>(undefined)
  const windowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  useEffect(() => {
    if (!config || !containerRef.current) {
      // Cleanup previous webview if config becomes null
      if (webviewState.webview) {
        webviewState.webview.close().catch(console.error)
        setWebviewState({ webview: null, isInitialized: false })
      }
      return
    }

    let webview: Webview | null = null
    let isActive = true
    let unlistenResize: (() => void) | null = null
    let unlistenMove: (() => void) | null = null

    const updateWebviewPosition = async () => {
      if (!webview || !containerRef.current || !isActive) return

      const rect = containerRef.current.getBoundingClientRect()

      // The containerRef is the whole panel, we need to account for the 48px header
      const previewHeaderHeight = 48
      const coordinateOffset = 28 // Empirical offset for title bar/chrome
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

      try {
        await webview.setPosition(new LogicalPosition(Math.floor(rect.left), webviewTop))
        await webview.setSize(new LogicalSize(Math.floor(rect.width), webviewHeight))
      } catch (error) {
        // Silently ignore errors if webview was closed
        if (isActive) {
          console.error('Failed to update webview position/size:', error)
        }
      }
    }

    const requestPositionUpdate = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        updateWebviewPosition()
      })
    }

    const initWebview = async () => {
      try {
        windowRef.current = getCurrentWindow()
        const container = containerRef.current
        if (!container || !isActive) return

        // Wait for layout to fully settle before measuring
        await new Promise((resolve) => requestAnimationFrame(resolve))
        await new Promise((resolve) => requestAnimationFrame(resolve))

        if (!isActive || !containerRef.current) return

        // Get container position relative to viewport
        const rect = containerRef.current.getBoundingClientRect()

        // Account for 48px Preview header + empirical offset
        const previewHeaderHeight = 48
        // Note: Adding 30px empirical offset because getBoundingClientRect() and Tauri coordinates
        // don't perfectly align (likely due to title bar/chrome that isn't reported correctly)
        const coordinateOffset = 30
        const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
        const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

        const webviewOptions: WebviewOptions = {
          url: config.url,
          x: Math.floor(rect.left),
          y: webviewTop,
          width: Math.floor(rect.width),
          height: webviewHeight,
        }

        const webviewLabel = `sidebar-webview-${Date.now()}`
        webview = new Webview(windowRef.current, webviewLabel, webviewOptions)

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
          requestPositionUpdate()
        })

        if (container) {
          resizeObserverRef.current.observe(container)
        }

        // Listen for window resize events
        unlistenResize = await windowRef.current.onResized(() => {
          requestPositionUpdate()
        })

        // Listen for window move events
        unlistenMove = await windowRef.current.onMoved(() => {
          requestPositionUpdate()
        })
      } catch (error) {
        console.error('Failed to initialize sidebar webview:', error)
      }
    }

    initWebview()

    // Cleanup
    return () => {
      isActive = false

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
      if (unlistenResize) {
        unlistenResize()
      }
      if (unlistenMove) {
        unlistenMove()
      }
      if (webview) {
        webview.close().catch(console.error)
      }
    }
  }, [config?.url]) // Re-initialize if URL changes

  const closeWebview = async () => {
    if (webviewState.webview) {
      try {
        await webviewState.webview.close()
        setWebviewState({ webview: null, isInitialized: false })
        if (config?.onClose) {
          config.onClose()
        }
      } catch (error) {
        console.error('Error closing webview:', error)
      }
    }
  }

  return {
    ...webviewState,
    closeWebview,
  }
}
