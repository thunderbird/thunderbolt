import type { SidebarWebviewConfig } from '@/hooks/use-sidebar-webview'
import type { ToolUIPart } from 'ai'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'

type RightSidebarState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ToolUIPart }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: { sideviewType: string; sideviewId: string } }

type RightSidebarContextType = {
  state: RightSidebarState
  showObjectView: (content: ToolUIPart) => void
  showPreview: (url: string) => void
  showSideview: (sideviewType: string | null, sideviewId: string | null) => void
  close: () => void
  isOpen: boolean
}

const RightSidebarContext = createContext<RightSidebarContextType | undefined>(undefined)

/**
 * Unified provider for managing the right sidebar content
 *
 * The right sidebar can display:
 * - Object views (tool call results)
 * - Webview previews (link previews)
 * - Sideviews (email detail, task detail, etc)
 */
export const RightSidebarProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<RightSidebarState>({ type: null, data: null })

  const showObjectView = useCallback((content: ToolUIPart) => {
    setState({ type: 'object-view', data: content })
  }, [])

  const showPreview = useCallback((url: string) => {
    setState({
      type: 'preview',
      data: {
        url,
        onClose: () => setState({ type: null, data: null }),
      },
    })
  }, [])

  const showSideview = useCallback((sideviewType: string | null, sideviewId: string | null) => {
    if (sideviewType === null || sideviewId === null) {
      setState({ type: null, data: null })
    } else {
      setState({
        type: 'sideview',
        data: { sideviewType, sideviewId },
      })
    }
  }, [])

  const close = useCallback(() => {
    setState({ type: null, data: null })
  }, [])

  return (
    <RightSidebarContext.Provider
      value={{
        state,
        showObjectView,
        showPreview,
        showSideview,
        close,
        isOpen: state.type !== null,
      }}
    >
      {children}
    </RightSidebarContext.Provider>
  )
}

/**
 * Hook to access the unified right sidebar context
 */
export const useRightSidebar = () => {
  const context = useContext(RightSidebarContext)
  if (context === undefined) {
    throw new Error('useRightSidebar must be used within a RightSidebarProvider')
  }
  return context
}

// Backwards compatibility hooks for existing code
export const useObjectView = () => {
  const { showObjectView, close, state } = useRightSidebar()
  return {
    objectContent: state.type === 'object-view' ? state.data : undefined,
    openObjectSidebar: showObjectView,
    closeObjectSidebar: close,
  }
}

export const usePreview = () => {
  const { showPreview, close, state } = useRightSidebar()
  return {
    previewConfig: state.type === 'preview' ? state.data : null,
    showPreview,
    closePreview: close,
    isPreviewOpen: state.type === 'preview',
  }
}

export const useSideview = () => {
  const { showSideview, state } = useRightSidebar()
  return {
    sideviewType: state.type === 'sideview' ? state.data.sideviewType : null,
    sideviewId: state.type === 'sideview' ? state.data.sideviewId : null,
    setSideview: showSideview,
  }
}
