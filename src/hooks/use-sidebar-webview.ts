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
        console.log('Closing webview due to config change')
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
      const PREVIEW_HEADER_HEIGHT = 48
      const COORDINATE_OFFSET = 28 // Empirical offset for title bar/chrome
      const webviewTop = Math.floor(rect.top) + PREVIEW_HEADER_HEIGHT + COORDINATE_OFFSET
      const webviewHeight = Math.floor(rect.height) - PREVIEW_HEADER_HEIGHT

      console.log('Updating webview position:', {
        panelTop: Math.floor(rect.top),
        headerHeight: PREVIEW_HEADER_HEIGHT,
        webviewTop,
        left: Math.floor(rect.left),
        width: Math.floor(rect.width),
        webviewHeight,
      })

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

        // Get window's outer size and inner size to calculate title bar height
        const outerSize = await windowRef.current.outerSize()
        const innerSize = await windowRef.current.innerSize()
        const titleBarHeight = outerSize.height - innerSize.height

        console.log('🔍 Window chrome detection:', {
          'outerSize.height': outerSize.height,
          'innerSize.height': innerSize.height,
          '➡️ Title bar height': titleBarHeight,
        })

        // Account for 48px Preview header + empirical offset
        const PREVIEW_HEADER_HEIGHT = 48
        // Note: Adding 30px empirical offset because getBoundingClientRect() and Tauri coordinates
        // don't perfectly align (likely due to title bar/chrome that isn't reported correctly)
        const COORDINATE_OFFSET = 30
        const webviewTop = Math.floor(rect.top) + PREVIEW_HEADER_HEIGHT + COORDINATE_OFFSET
        const webviewHeight = Math.floor(rect.height) - PREVIEW_HEADER_HEIGHT

        console.log('🔍 INITIAL POSITIONING DEBUG:', {
          'Panel rect.top (viewport)': rect.top,
          'Panel rect.left': rect.left,
          'Panel rect.height': rect.height,
          'Title bar height': titleBarHeight,
          'Preview header': PREVIEW_HEADER_HEIGHT,
          '➡️ Calculated webviewTop': webviewTop,
          '➡️ Calculated webviewHeight': webviewHeight,
        })

        const webviewOptions: WebviewOptions = {
          url: config.url,
          x: Math.floor(rect.left),
          y: webviewTop,
          width: Math.floor(rect.width),
          height: webviewHeight,
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
      console.log('Cleaning up sidebar webview')

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
        console.log('Closing webview in cleanup')
        webview.close().catch(console.error)
      }
    }
  }, [config?.url]) // Re-initialize if URL changes

  const closeWebview = async () => {
    console.log('Hook: closeWebview called, webview exists:', !!webviewState.webview)
    if (webviewState.webview) {
      console.log('Hook: Closing webview...')
      try {
        await webviewState.webview.close()
        console.log('Hook: Webview closed successfully')
        setWebviewState({ webview: null, isInitialized: false })
        console.log('Hook: State updated to null')
        if (config?.onClose) {
          console.log('Hook: Calling config.onClose')
          config.onClose()
        }
      } catch (error) {
        console.error('Hook: Error closing webview:', error)
      }
    } else {
      console.log('Hook: No webview to close')
    }
  }

  return {
    ...webviewState,
    closeWebview,
  }
}
