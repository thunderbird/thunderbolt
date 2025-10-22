import { DualWebviewContainer } from '@/components/dual-webview-container'
import { isTauri } from '@/lib/platform'
import { useEffect, useState } from 'react'

/**
 * Example page demonstrating dual side-by-side webviews
 *
 * To use this:
 * 1. Navigate to this route in your app
 * 2. The component will create two webviews side-by-side
 * 3. You can drag the splitter to resize the panes
 *
 * Customize the URLs below to show different content in each pane
 */
export default function DualWebviewExample() {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    // Only initialize in Tauri environment
    if (isTauri()) {
      setIsReady(true)
    }
  }, [])

  if (!isTauri()) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Dual Webview Demo</h2>
          <p className="text-muted-foreground">This feature is only available in the Tauri desktop app.</p>
        </div>
      </div>
    )
  }

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <DualWebviewContainer
      config={{
        // Left pane - you can use any URL here
        leftUrl: 'http://localhost:1420',

        // Right pane - you can use any URL here
        rightUrl: 'http://localhost:1420?sideview=thread:example',

        // Optional: set initial split ratio (0.5 = 50/50)
        splitRatio: 0.5,
      }}
      showSplitter={true}
    />
  )
}
