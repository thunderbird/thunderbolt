import type { SidebarWebviewConfig } from '@/hooks/use-sidebar-webview'
import { createContext, type ReactNode, useContext, useState } from 'react'

type PreviewContextType = {
  previewConfig: SidebarWebviewConfig | null
  showPreview: (url: string) => void
  closePreview: () => void
  isPreviewOpen: boolean
}

const PreviewContext = createContext<PreviewContextType | undefined>(undefined)

/**
 * Provider for managing webview previews globally
 *
 * This allows any component (like link preview widgets) to trigger
 * a webview preview in the sidebar without prop drilling.
 */
export const PreviewProvider = ({ children }: { children: ReactNode }) => {
  const [previewConfig, setPreviewConfig] = useState<SidebarWebviewConfig | null>(null)

  const showPreview = (url: string) => {
    setPreviewConfig({
      url,
      onClose: () => setPreviewConfig(null),
    })
  }

  const closePreview = () => {
    setPreviewConfig(null)
  }

  return (
    <PreviewContext.Provider
      value={{
        previewConfig,
        showPreview,
        closePreview,
        isPreviewOpen: previewConfig !== null,
      }}
    >
      {children}
    </PreviewContext.Provider>
  )
}

/**
 * Hook to access preview context
 *
 * @example
 * ```tsx
 * const { showPreview, closePreview, isPreviewOpen } = usePreview()
 *
 * // Show a preview
 * showPreview('https://example.com')
 *
 * // Close it
 * closePreview()
 * ```
 */
export const usePreview = () => {
  const context = useContext(PreviewContext)
  if (context === undefined) {
    throw new Error('usePreview must be used within a PreviewProvider')
  }
  return context
}
