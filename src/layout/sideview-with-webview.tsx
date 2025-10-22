import { SidebarWebview } from '@/components/sidebar-webview'
import type { SidebarWebviewConfig } from '@/hooks/use-sidebar-webview'
import { useSideview } from '@/sideview/provider'
import { EmailThreadView } from '@/sideview/thread'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

/**
 * Enhanced Sideview component with webview preview support
 *
 * When a preview link is clicked, it can show a full webview in the sidebar.
 * The webview takes full width/height of the sidebar and automatically
 * resizes when the sidebar is resized.
 *
 * Usage:
 * 1. Call `showWebviewPreview(url)` when user clicks a preview link
 * 2. The webview will appear filling the sidebar
 * 3. User can close it with the X button or call `closeWebviewPreview()`
 */
export function SideviewWithWebview() {
  const { sideviewId, sideviewType } = useSideview()
  const [webviewConfig, setWebviewConfig] = useState<SidebarWebviewConfig | null>(null)

  const { data: _object } = useQuery({
    queryKey: ['sideview', sideviewType, sideviewId],
    queryFn: async () => {
      if (!sideviewId || !sideviewType) return null

      switch (sideviewType) {
        case 'message':
          // @todo re-implement this
          return null
        case 'thread':
          // @todo re-implement this
          return null
        default:
          return null
      }
    },
    enabled: !!sideviewId && !!sideviewType,
  })

  const closeWebviewPreview = () => {
    setWebviewConfig(null)
  }

  // If webview is active, show it instead of regular content
  if (webviewConfig) {
    return <SidebarWebview config={webviewConfig} onClose={closeWebviewPreview} />
  }

  // Regular sideview content
  // TODO: Pass showWebviewPreview to components that need it
  switch (sideviewType) {
    case 'message':
      return <EmailThreadView />
    case 'thread':
      return <EmailThreadView />
    default:
      return <div>Unsupported sideview type</div>
  }
}

// Export the helper function for use elsewhere
export const useSideviewWebview = () => {
  const [webviewConfig, setWebviewConfig] = useState<SidebarWebviewConfig | null>(null)

  const showPreview = (url: string) => {
    setWebviewConfig({
      url,
      onClose: () => setWebviewConfig(null),
    })
  }

  const closePreview = () => {
    setWebviewConfig(null)
  }

  return {
    webviewConfig,
    showPreview,
    closePreview,
    isPreviewOpen: webviewConfig !== null,
  }
}
