import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Webview, type WebviewOptions } from '@tauri-apps/api/webview'
import { useEffect, useRef, useState } from 'react'

export type DualWebviewConfig = {
  leftUrl: string
  rightUrl: string
  splitRatio?: number // 0 to 1, default 0.5 (50/50 split)
}

type WebviewState = {
  left: Webview | null
  right: Webview | null
  isInitialized: boolean
}

/**
 * Hook to manage dual side-by-side webviews in a Tauri window
 */
export const useDualWebview = (config: DualWebviewConfig) => {
  const [webviewState, setWebviewState] = useState<WebviewState>({
    left: null,
    right: null,
    isInitialized: false,
  })
  const [splitRatio, setSplitRatio] = useState(config.splitRatio ?? 0.5)
  const resizeTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const windowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  // Initialize webviews
  useEffect(() => {
    let leftWebview: Webview | null = null
    let rightWebview: Webview | null = null
    let unlistenResize: (() => void) | null = null

    const initWebviews = async () => {
      try {
        windowRef.current = getCurrentWindow()
        const size = await windowRef.current.innerSize()
        const windowWidth = size.width
        const windowHeight = size.height

        // Calculate split positions
        const leftWidth = Math.floor(windowWidth * splitRatio)
        const rightWidth = windowWidth - leftWidth

        // Create left webview
        const leftOptions: WebviewOptions = {
          url: config.leftUrl,
          x: 0,
          y: 0,
          width: leftWidth,
          height: windowHeight,
        }
        leftWebview = new Webview(windowRef.current, `left-${Date.now()}`, leftOptions)

        // Create right webview
        const rightOptions: WebviewOptions = {
          url: config.rightUrl,
          x: leftWidth,
          y: 0,
          width: rightWidth,
          height: windowHeight,
        }
        rightWebview = new Webview(windowRef.current, `right-${Date.now()}`, rightOptions)

        // Listen for window resize events
        unlistenResize = await windowRef.current.onResized(async ({ payload: size }) => {
          // Debounce resize events
          if (resizeTimeoutRef.current) {
            clearTimeout(resizeTimeoutRef.current)
          }

          resizeTimeoutRef.current = setTimeout(async () => {
            if (!leftWebview || !rightWebview) return

            const newWidth = size.width
            const newHeight = size.height
            const newLeftWidth = Math.floor(newWidth * splitRatio)
            const newRightWidth = newWidth - newLeftWidth

            // Update webview positions and sizes
            await leftWebview.setSize(new LogicalSize(newLeftWidth, newHeight))
            await rightWebview.setPosition(new LogicalPosition(newLeftWidth, 0))
            await rightWebview.setSize(new LogicalSize(newRightWidth, newHeight))
          }, 100) // 100ms debounce
        })

        setWebviewState({
          left: leftWebview,
          right: rightWebview,
          isInitialized: true,
        })
      } catch (error) {
        console.error('Failed to initialize dual webviews:', error)
      }
    }

    initWebviews()

    // Cleanup on unmount
    return () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
      }
      if (unlistenResize) {
        unlistenResize()
      }
      // Note: Webviews are automatically destroyed when the window closes
      // but we could explicitly destroy them here if needed
    }
  }, [config.leftUrl, config.rightUrl, splitRatio])

  // Function to update split ratio dynamically
  const updateSplitRatio = async (newRatio: number) => {
    if (newRatio < 0.1 || newRatio > 0.9) {
      console.warn('Split ratio must be between 0.1 and 0.9')
      return
    }

    setSplitRatio(newRatio)

    if (!webviewState.left || !webviewState.right || !windowRef.current) return

    try {
      const size = await windowRef.current.innerSize()
      const windowWidth = size.width
      const windowHeight = size.height

      const leftWidth = Math.floor(windowWidth * newRatio)
      const rightWidth = windowWidth - leftWidth

      await webviewState.left.setSize(new LogicalSize(leftWidth, windowHeight))
      await webviewState.right.setPosition(new LogicalPosition(leftWidth, 0))
      await webviewState.right.setSize(new LogicalSize(rightWidth, windowHeight))
    } catch (error) {
      console.error('Failed to update split ratio:', error)
    }
  }

  return {
    ...webviewState,
    splitRatio,
    updateSplitRatio,
  }
}
