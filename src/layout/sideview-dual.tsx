import { DualWebviewContainer } from '@/components/dual-webview-container'
import { isTauri } from '@/lib/platform'
import { useSideview } from '@/sideview/provider'

/**
 * Alternative sideview implementation using dual webviews
 *
 * This component shows the main app on the left and the sideview content on the right
 * in two separate webviews within the same window.
 *
 * To use this instead of the default sideview:
 * 1. Import this component instead of the default Sideview
 * 2. Replace <Sideview /> with <SideviewDual /> in your layout
 */
export const SideviewDual = () => {
  const { sideviewId, sideviewType } = useSideview()

  if (!isTauri()) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Dual webview only available in desktop app</p>
      </div>
    )
  }

  // Build the sideview URL
  const baseUrl = 'http://localhost:1420'
  const sideviewUrl =
    sideviewType && sideviewId ? `${baseUrl}?sideview=${sideviewType}:${encodeURIComponent(sideviewId)}` : baseUrl

  return (
    <DualWebviewContainer
      config={{
        leftUrl: baseUrl,
        rightUrl: sideviewUrl,
        splitRatio: 0.5,
      }}
      showSplitter={true}
    />
  )
}
