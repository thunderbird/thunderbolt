/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import { useChatStore } from '@/chats/chat-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { getMcpToolDisplay } from '@/lib/mcp-tool-display'
import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { formatToolOutput } from '@/lib/utils'
import type { UIMessageMetadata } from '@/types'
import { getToolName, type DynamicToolUIPart, type ReasoningUIPart, type ToolUIPart } from 'ai'
import { createContext, type ReactNode, useCallback, useContext, useReducer } from 'react'
import type { SidebarWebviewConfig } from './use-sidebar-webview'
import { useBackClosesView } from './use-back-closes-view'
import type { CompactionSummary } from '@/components/context-usage'

/** A tool call (built-in or MCP dynamic-tool) or a reasoning part shown in the object view. */
export type ObjectViewContent = ToolUIPart | DynamicToolUIPart | ReasoningUIPart

export type ObjectViewData = {
  title: string
  /** The call's arguments; tool calls only. */
  input?: string
  output: string
}

export type SideviewData = {
  sideviewType: string
  sideviewId: string
  /**
   * What had focus when the file opened, usually its card in the chat. It gets focus back when Escape closes the panel.
   * Kept here and not in the viewer, because Try again remounts the viewer.
   */
  opener: Element | null
}

/** A verified HTML artifact shown in the side panel. */
export type ArtifactViewData = {
  html: string
  title: string
  /** The render_html tool-call id; also the key for the render-target toggle. */
  artifactId: string
  /**
   * The conversation that produced it, so a highlighted passage has somewhere
   * to go.
   *
   * Carried with the view rather than read from the route. `/apps/:appId` has
   * no `chatThreadId` param — its conversation is held by the Mini App panel —
   * so deriving it from `useParams` dropped every passage picked out of an
   * artifact opened beside an app, and warned about a missing composer while a
   * real one was open.
   */
  chatThreadId: string | null
}

type ContentViewState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ObjectViewData }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: SideviewData }
  | { type: 'artifact'; data: ArtifactViewData }
  | { type: 'compaction-summary'; data: CompactionSummary }

const closedView: ContentViewState = { type: null, data: null }

type ProviderState = { view: ContentViewState; previewHidden: boolean; sessionId: string | null }

type ProviderAction =
  | { type: 'show'; view: ContentViewState }
  | { type: 'hide-preview'; hidden: boolean }
  | { type: 'switch-chat'; sessionId: string | null }

/** The open view, whether its preview is hidden, and the chat it belongs to. Switching chats closes the view. */
const providerReducer = (state: ProviderState, action: ProviderAction): ProviderState => {
  switch (action.type) {
    case 'show':
      return { ...state, view: action.view }
    case 'hide-preview':
      return { ...state, previewHidden: action.hidden }
    case 'switch-chat':
      return { ...state, sessionId: action.sessionId, view: closedView }
  }
}

type ContentViewContextType = {
  state: ContentViewState
  showObjectView: (content: ObjectViewContent, mcpTools?: UIMessageMetadata['mcpTools']) => void
  showPreview: (url: string) => void
  /** Open a typed sideview (e.g. `'document'`). Passing `null` clears the view. */
  showSideview: (sideviewType: string | null, sideviewId: string | null) => void
  /** Open a verified HTML artifact in the side panel. */
  showArtifact: (data: ArtifactViewData) => void
  /** Inspect a local or agent-provided summary without changing the conversation. */
  showCompactionSummary: (checkpoint: CompactionSummary) => void
  close: () => void
  isOpen: boolean
  previewHidden: boolean
  setPreviewHidden: (hidden: boolean) => void
}

const ContentViewContext = createContext<ContentViewContextType | undefined>(undefined)
const ShowCompactionSummaryContext = createContext<ContentViewContextType['showCompactionSummary'] | undefined>(
  undefined,
)

/**
 * Unified provider for managing the content view
 *
 * The content view can display:
 * - Object views (tool call results)
 * - Webview previews (link previews)
 * - Sideviews (document viewer, etc.)
 */
const reasoningViewTitle = msg`Reasoning`

export const ContentViewProvider = ({
  children,
  trackEvent = defaultTrackEvent,
}: {
  children: ReactNode
  trackEvent?: typeof defaultTrackEvent
}) => {
  // The provider sits above the routes, so a view would outlive the chat it shows a file from: switching chats closes it.
  const currentSessionId = useChatStore((store) => store.currentSessionId)
  const [{ view: state, previewHidden, sessionId }, dispatch] = useReducer(providerReducer, {
    view: closedView,
    previewHidden: false,
    sessionId: currentSessionId,
  })
  if (sessionId !== currentSessionId) {
    dispatch({ type: 'switch-chat', sessionId: currentSessionId })
  }
  const setPreviewHidden = useCallback((hidden: boolean) => dispatch({ type: 'hide-preview', hidden }), [])

  const showObjectView = useCallback(
    (content: ObjectViewContent, mcpTools?: UIMessageMetadata['mcpTools']) => {
      if (content.type === 'reasoning') {
        trackEvent('content_view_open', { view_type: 'object-view', reasoning: true })
        // Resolved eagerly in the click handler: the title is a snapshot stored
        // in state, so it uses the `i18n` singleton rather than `useLingui`.
        dispatch({
          type: 'show',
          view: { type: 'object-view', data: { title: i18n._(reasoningViewTitle), output: content.text } },
        })
        return
      }

      const toolName = getToolName(content)
      // MCP dynamic-tool parts resolve their title from the tool map; built-ins use curated metadata.
      const title =
        content.type === 'dynamic-tool'
          ? getMcpToolDisplay(toolName, mcpTools, content.title).displayName
          : getToolMetadataSync(toolName, content.input).displayName
      // Surface the error text when a tool failed; otherwise show its output.
      const output = content.state === 'output-error' ? content.errorText : formatToolOutput(content.output)
      trackEvent('content_view_open', {
        view_type: 'object-view',
        tool_name: content.type === 'dynamic-tool' ? 'mcp' : toolName,
      })
      dispatch({
        type: 'show',
        view: { type: 'object-view', data: { title, input: formatToolOutput(content.input), output } },
      })
    },
    [trackEvent],
  )

  const showPreview = useCallback(
    (url: string) => {
      trackEvent('content_view_open', { view_type: 'preview' })
      trackEvent('preview_open')
      dispatch({
        type: 'show',
        view: { type: 'preview', data: { url, onClose: () => dispatch({ type: 'show', view: closedView }) } },
      })
    },
    [trackEvent],
  )

  const showSideview = useCallback(
    (sideviewType: string | null, sideviewId: string | null) => {
      if (sideviewType === null || sideviewId === null) {
        dispatch({ type: 'show', view: closedView })
        return
      }
      trackEvent('content_view_open', { view_type: 'sideview', sideview_type: sideviewType })
      dispatch({
        type: 'show',
        view: { type: 'sideview', data: { sideviewType, sideviewId, opener: document.activeElement } },
      })
    },
    [trackEvent],
  )

  const showArtifact = useCallback(
    (data: ArtifactViewData) => {
      trackEvent('content_view_open', { view_type: 'artifact' })
      dispatch({ type: 'show', view: { type: 'artifact', data } })
    },
    [trackEvent],
  )

  const close = useCallback(() => {
    if (state.type !== null) {
      trackEvent('content_view_close', { view_type: state.type })
    }
    dispatch({ type: 'show', view: closedView })
  }, [state.type, trackEvent])

  // Below the breakpoint the view is a full-window dialog, so Back closes it like any other screen.
  const { isMobile } = useIsMobile()
  useBackClosesView(isMobile && state.type !== null, close)

  const showCompactionSummary = useCallback(
    (checkpoint: CompactionSummary) => {
      trackEvent('content_view_open', { view_type: 'compaction-summary' })
      dispatch({ type: 'show', view: { type: 'compaction-summary', data: checkpoint } })
    },
    [trackEvent],
  )

  return (
    <ContentViewContext.Provider
      value={{
        state,
        showObjectView,
        showPreview,
        showSideview,
        showArtifact,
        showCompactionSummary,
        close,
        isOpen: state.type !== null,
        previewHidden,
        setPreviewHidden,
      }}
    >
      <ShowCompactionSummaryContext.Provider value={showCompactionSummary}>
        {children}
      </ShowCompactionSummaryContext.Provider>
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

/** Returns showSideview when inside ContentViewProvider, undefined otherwise. */
export const useShowSideview = (): ContentViewContextType['showSideview'] | undefined => {
  return useContext(ContentViewContext)?.showSideview
}

/** Returns setPreviewHidden when inside ContentViewProvider, undefined otherwise. */
export const useSetPreviewHidden = (): ((hidden: boolean) => void) | undefined => {
  return useContext(ContentViewContext)?.setPreviewHidden
}

/** Access the active sideview state. */
export const useSideview = () => {
  const { showSideview, state, close } = useContentView()
  return {
    sideviewType: state.type === 'sideview' ? state.data.sideviewType : null,
    sideviewId: state.type === 'sideview' ? state.data.sideviewId : null,
    opener: state.type === 'sideview' ? state.data.opener : null,
    showSideview,
    closeSideview: close,
  }
}

/** Open summaries without subscribing the message list to side-panel state. */
export const useShowCompactionSummary = () => {
  const show = useContext(ShowCompactionSummaryContext)
  if (!show) {
    throw new Error('useShowCompactionSummary must be used within a ContentViewProvider')
  }
  return show
}
