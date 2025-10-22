import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'

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
  const webviewLabelRef = useRef<string | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const windowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  useEffect(() => {
    if (!config || !containerRef.current) {
      return
    }

    let webviewLabel: string | null = null
    let isActive = true
    let unlistenResize: (() => void) | null = null
    let unlistenMove: (() => void) | null = null

    const updateWebviewPosition = async () => {
      if (!webviewLabel || !containerRef.current || !isActive) return

      const rect = containerRef.current.getBoundingClientRect()

      const previewHeaderHeight = 48 // Header height
      const coordinateOffset = 28 // Empirical offset for title bar/chrome
      const borderOffset = 0 // Account for ResizableHandle border on the left
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

      try {
        await invoke('update_sidebar_webview_bounds', {
          label: webviewLabel,
          x: Math.floor(rect.left) + borderOffset,
          y: webviewTop,
          width: Math.floor(rect.width) - borderOffset,
          height: webviewHeight,
        })
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
        // Note: Adding 28px empirical offset because getBoundingClientRect() and Tauri coordinates
        // don't perfectly align (likely due to title bar/chrome that isn't reported correctly)
        const coordinateOffset = 28
        const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
        const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

        const borderOffset = 0 // Account for ResizableHandle border on the left

        const label = `sidebar-webview-${Date.now()}`

        // Use custom Tauri command that creates webview with non-persistent storage
        // This combines incognito mode with data_store_identifier to prevent keychain access
        await invoke('create_sidebar_webview', {
          label,
          url: config.url,
          x: Math.floor(rect.left) + borderOffset,
          y: webviewTop,
          width: Math.floor(rect.width) - borderOffset,
          height: webviewHeight,
        })

        if (!isActive) {
          // Component unmounted while we were creating the webview
          await invoke('close_sidebar_webview', { label }).catch(console.error)
          return
        }

        webviewLabel = label
        webviewLabelRef.current = label
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
      if (webviewLabel) {
        invoke('close_sidebar_webview', { label: webviewLabel }).catch(console.error)
      }
      webviewLabelRef.current = null
      setIsInitialized(false)
    }
  }, [config?.url]) // Re-initialize if URL changes

  const closeWebview = async () => {
    if (webviewLabelRef.current) {
      try {
        await invoke('close_sidebar_webview', { label: webviewLabelRef.current })
        webviewLabelRef.current = null
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
    webview: webviewLabelRef.current,
    isInitialized,
    closeWebview,
  }
}
