import { useIsMobile } from '@/hooks/use-mobile'
import { trackEvent } from '@/lib/posthog'
import type { ToolUIPart } from 'ai'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { SidebarWebviewConfig } from './use-sidebar-webview'

type ContentViewState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ToolUIPart }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: { sideviewType: string; sideviewId: string } }

type ContentViewContextType = {
  state: ContentViewState
  showObjectView: (content: ToolUIPart) => void
  showPreview: (url: string) => void
  showSideview: (sideviewType: string | null, sideviewId: string | null) => void
  close: () => void
  isOpen: boolean
}

const ContentViewContext = createContext<ContentViewContextType | undefined>(undefined)

type ContentViewProviderProps = {
  children: ReactNode
  initialSideviewType?: string | null
  initialSideviewId?: string | null
}

/**
 * Unified provider for managing the content view
 *
 * The content view can display:
 * - Object views (tool call results)
 * - Webview previews (link previews)
 * - Sideviews (email detail, task detail, etc)
 *
 * Optionally accepts initial sideview state to open on mount
 */
export const ContentViewProvider = ({ children, initialSideviewType, initialSideviewId }: ContentViewProviderProps) => {
  const [state, setState] = useState<ContentViewState>({ type: null, data: null })
  const { isMobile } = useIsMobile()
  const prevIsMobile = useRef(isMobile)

  const showObjectView = useCallback((content: ToolUIPart) => {
    const [, toolName] = content?.type?.split(':') ?? ['', 'unknown']
    trackEvent('content_view_open', { view_type: 'object-view', tool_name: toolName })
    setState({ type: 'object-view', data: content })
  }, [])

  const showPreview = useCallback((url: string) => {
    trackEvent('content_view_open', { view_type: 'preview' })
    trackEvent('preview_open')
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
      trackEvent('content_view_open', { view_type: 'sideview', sideview_type: sideviewType })
      setState({
        type: 'sideview',
        data: { sideviewType, sideviewId },
      })
    }
  }, [])

  const close = useCallback(() => {
    if (state.type !== null) {
      trackEvent('content_view_close', { view_type: state.type })
    }
    setState({ type: null, data: null })
  }, [])

  // Initialize with sideview if provided
  useEffect(() => {
    if (initialSideviewType && initialSideviewId) {
      showSideview(initialSideviewType, initialSideviewId)
    }
  }, [initialSideviewType, initialSideviewId, showSideview])

  // Close content view when crossing into mobile mode (only on transition, not continuously)
  useEffect(() => {
    const crossedIntoMobileWithContentViewOpen = !prevIsMobile.current && isMobile && state.type !== null
    if (crossedIntoMobileWithContentViewOpen) {
      close()
    }
    prevIsMobile.current = isMobile
  }, [isMobile, state.type, close])

  return (
    <ContentViewContext.Provider
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
    </ContentViewContext.Provider>
  )
}

/**
 * Hook to access the unified content view context
 */
export const useContentView = () => {
  const context = useContext(ContentViewContext)
  if (context === undefined) {
    throw new Error('useContentView must be used within a ContentViewProvider')
  }
  return context
}

// Backwards compatibility hooks for existing code
export const useObjectView = () => {
  const { showObjectView, close, state } = useContentView()
  return {
    objectContent: state.type === 'object-view' ? state.data : undefined,
    openObjectSidebar: showObjectView,
    closeObjectSidebar: close,
  }
}

export const usePreview = () => {
  const { showPreview, close, state } = useContentView()
  return {
    previewConfig: state.type === 'preview' ? state.data : null,
    showPreview,
    closePreview: close,
    isPreviewOpen: state.type === 'preview',
  }
}

export const useSideview = () => {
  const { showSideview, state } = useContentView()
  return {
    sideviewType: state.type === 'sideview' ? state.data.sideviewType : null,
    sideviewId: state.type === 'sideview' ? state.data.sideviewId : null,
    setSideview: showSideview,
  }
}
