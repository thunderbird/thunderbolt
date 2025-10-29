import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Webview, type WebviewOptions } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'
import { borderOffset, coordinateOffset, previewHeaderHeight } from './constants'

export type SidebarWebviewConfig = {
  url: string
  onClose?: () => void
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
  const [isInitialized, setIsInitialized] = useState(false)
  const webviewRef = useRef<Webview | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const windowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  useEffect(() => {
    if (!config || !containerRef.current) {
      return
    }

    let webview: Webview | null = null
    let isActive = true
    let unlistenResize: (() => void) | null = null
    let unlistenMove: (() => void) | null = null

    const updateWebviewPosition = async () => {
      // Use ref instead of local variable to get current state
      const currentWebview = webviewRef.current
      if (!currentWebview || !containerRef.current || !isActive) return

      const rect = containerRef.current.getBoundingClientRect()

      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

      try {
        await currentWebview.setPosition(new LogicalPosition(Math.floor(rect.left) + borderOffset, webviewTop))
        await currentWebview.setSize(new LogicalSize(Math.floor(rect.width) - borderOffset, webviewHeight))
      } catch (error) {
        // Silently ignore errors if webview was closed
        if (isActive && webviewRef.current) {
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

        if (!isActive || !containerRef.current) return

        // Get container position relative to viewport
        const rect = containerRef.current.getBoundingClientRect()

        const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
        const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

        const webviewOptions: WebviewOptions = {
          url: config.url,
          x: Math.floor(rect.left) + borderOffset,
          y: webviewTop,
          width: Math.floor(rect.width) - borderOffset,
          height: webviewHeight,
          incognito: true, // Use incognito mode for privacy and to prevent keychain access for WebCrypto API
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

        webviewRef.current = webview
        setIsInitialized(true)

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

    // Cleanup when component unmounts OR page navigates/refreshes
    const cleanupWebview = () => {
      isActive = false

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
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
      // Only close if not already closed by closeWebview()
      if (webview && webviewRef.current) {
        webview.close().catch(console.error)
      }
      webviewRef.current = null
      setIsInitialized(false)
    }

    // Handle page unload (refresh/navigation) - close webview immediately
    // Note: Tauri requires 'unload' instead of 'beforeunload' for reliable cleanup
    const handleUnload = () => {
      // Use ref to ensure we have the latest webview instance
      if (webviewRef.current) {
        // Close synchronously to ensure it happens before page unloads
        webviewRef.current.close().catch(console.error)
      }
    }

    window.addEventListener('unload', handleUnload)

    return () => {
      window.removeEventListener('unload', handleUnload)
      cleanupWebview()
    }
  }, [config?.url]) // Re-initialize if URL changes

  const closeWebview = async () => {
    if (webviewRef.current) {
      // Cancel any pending position updates
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }

      try {
        await webviewRef.current.close()
        webviewRef.current = null
        setIsInitialized(false)
        if (config?.onClose) {
          config.onClose()
        }
      } catch (error) {
        console.error('Error closing webview:', error)
      }
    }
  }

  return {
    webview: webviewRef.current,
    isInitialized,
    closeWebview,
  }
}
