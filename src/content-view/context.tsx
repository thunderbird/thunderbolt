import { useIsMobile } from '@/hooks/use-mobile'
import { trackEvent } from '@/lib/posthog'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { SidebarWebviewConfig } from './use-sidebar-webview'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { formatToolOutput, splitPartType } from '@/lib/utils'

export type ObjectViewData = {
  title: string
  output: string
}

type ContentViewState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ObjectViewData }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: { sideviewType: string; sideviewId: string } }

type ContentViewContextType = {
  state: ContentViewState
  showObjectView: (content: ToolUIPart | ReasoningUIPart) => void
  showPreview: (url: string) => void
  showSideview: (sideviewType: string | null, sideviewId: string | null) => void
  close: () => void
  isOpen: boolean
  previewHidden: boolean
  setPreviewHidden: (hidden: boolean) => void
}

const ContentViewContext = createContext<ContentViewContextType | undefined>(undefined)

/**
 * Unified provider for managing the content view
 *
 * The content view can display:
 * - Object views (tool call results)
 * - Webview previews (link previews)
 */
type ContentViewProviderProps = {
  children: ReactNode
  initialSideviewType?: string | null
  initialSideviewId?: string | null
}

export const ContentViewProvider = ({ children, initialSideviewType, initialSideviewId }: ContentViewProviderProps) => {
  const [state, setState] = useState<ContentViewState>(() =>
    initialSideviewType && initialSideviewId
      ? { type: 'sideview' as const, data: { sideviewType: initialSideviewType, sideviewId: initialSideviewId } }
      : { type: null, data: null },
  )
  const [previewHidden, setPreviewHidden] = useState(false)
  const { isMobile } = useIsMobile()
  const prevIsMobile = useRef(isMobile)

  const showObjectView = useCallback((content: ToolUIPart | ReasoningUIPart) => {
    if (content.type === 'reasoning') {
      trackEvent('content_view_open', { view_type: 'object-view', reasoning: true })
      setState({
        type: 'object-view',
        data: {
          title: 'Reasoning',
          output: content.text,
        },
      })
      return
    }

    const [, toolName] = splitPartType(content?.type ?? '')
    const metadata = getToolMetadataSync(toolName, content?.input)
    trackEvent('content_view_open', { view_type: 'object-view', tool_name: toolName })
    setState({
      type: 'object-view',
      data: {
        title: metadata.displayName,
        output: formatToolOutput(content.output),
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

  const close = useCallback(() => {
    if (state.type !== null) {
      trackEvent('content_view_close', { view_type: state.type })
    }
    setState({ type: null, data: null })
  }, [])

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
        previewHidden,
        setPreviewHidden,
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

/** Returns showPreview when inside ContentViewProvider, undefined otherwise. */
export const useShowPreview = (): ((url: string) => void) | undefined => {
  return useContext(ContentViewContext)?.showPreview
}

/** Returns setPreviewHidden when inside ContentViewProvider, undefined otherwise. */
export const useSetPreviewHidden = (): ((hidden: boolean) => void) | undefined => {
  return useContext(ContentViewContext)?.setPreviewHidden
}

export const useSideview = () => {
  const { showSideview, state } = useContentView()
  return {
    sideviewType: state.type === 'sideview' ? state.data.sideviewType : null,
    sideviewId: state.type === 'sideview' ? state.data.sideviewId : null,
    setSideview: showSideview,
  }
}
