/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, render, renderHook, fireEvent } from '@testing-library/react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EventType } from '@/lib/posthog'
import { usePageStore } from '@/pages/page-store'
import { memo, type ReactNode } from 'react'
import {
  ContentViewProvider,
  type ObjectViewContent,
  useContentView,
  useObjectView,
  useSideview,
  useShowCompactionSummary,
  usePreviewControls,
} from './context'

const wrapper = ({ children }: { children: ReactNode }) => <ContentViewProvider>{children}</ContentViewProvider>

describe('ContentView sideview mode', () => {
  test('showSideview transitions state to sideview', () => {
    const { result } = renderHook(() => useContentView(), { wrapper })

    expect(result.current.state.type).toBeNull()

    act(() => {
      result.current.showSideview('document', 'file-1:report.pdf')
    })

    expect(result.current.state.type).toBe('sideview')
    if (result.current.state.type === 'sideview') {
      expect(result.current.state.data).toEqual({ sideviewType: 'document', sideviewId: 'file-1:report.pdf' })
    }
    expect(result.current.isOpen).toBe(true)
  })

  test('showSideview with null clears the view', () => {
    const { result } = renderHook(() => useContentView(), { wrapper })

    act(() => {
      result.current.showSideview('document', 'file-1:report.pdf')
    })
    expect(result.current.state.type).toBe('sideview')

    act(() => {
      result.current.showSideview(null, null)
    })
    expect(result.current.state.type).toBeNull()
  })

  test('close() resets the sideview state', () => {
    const { result } = renderHook(() => useContentView(), { wrapper })

    act(() => {
      result.current.showSideview('document', 'file-1:report.pdf')
    })

    act(() => {
      result.current.close()
    })

    expect(result.current.state.type).toBeNull()
  })

  test('useSideview reports the active sideview', () => {
    const { result } = renderHook(
      () => {
        const cv = useContentView()
        const sv = useSideview()
        return { cv, sv }
      },
      { wrapper },
    )

    expect(result.current.sv.sideviewType).toBeNull()
    expect(result.current.sv.sideviewId).toBeNull()

    act(() => {
      result.current.cv.showSideview('document', 'file-1:report.pdf:2')
    })

    expect(result.current.sv.sideviewType).toBe('document')
    expect(result.current.sv.sideviewId).toBe('file-1:report.pdf:2')
  })

  test('object-view surfaces errorText for a failed tool call', () => {
    const { result } = renderHook(() => useObjectView(), { wrapper })

    const failedTool = {
      type: 'tool-search',
      toolCallId: 'call-1',
      state: 'output-error',
      input: {},
      errorText: 'Upstream 500',
    } as unknown as ToolUIPart

    act(() => {
      result.current.openObjectSidebar(failedTool)
    })

    expect(result.current.objectContent?.output).toBe('Upstream 500')
  })

  test('object-view resolves an MCP tool title from the tool map', () => {
    const trackEvent = mock((_eventName: EventType, _properties?: Record<string, unknown>) => {})
    const trackingWrapper = ({ children }: { children: ReactNode }) => (
      <ContentViewProvider trackEvent={trackEvent}>{children}</ContentViewProvider>
    )
    const { result } = renderHook(() => useObjectView(), { wrapper: trackingWrapper })

    const mcpTool = {
      type: 'dynamic-tool',
      toolName: 'render_list_services',
      toolCallId: 'call-2',
      state: 'output-available',
      input: {},
      output: { ok: true },
    } as unknown as DynamicToolUIPart

    act(() => {
      result.current.openObjectSidebar(mcpTool as ObjectViewContent, {
        render_list_services: { name: 'Render', url: 'https://render.com', toolName: 'list_services' },
      })
    })

    expect(result.current.objectContent?.title).toMatch(/List Services/i)
    expect(trackEvent).toHaveBeenCalledWith('content_view_open', {
      view_type: 'object-view',
      tool_name: 'mcp',
    })
  })

  test('showSideview overrides an active object-view', () => {
    const { result } = renderHook(() => useContentView(), { wrapper })

    act(() => {
      result.current.showObjectView({ type: 'reasoning', text: 'thinking' } as Parameters<
        typeof result.current.showObjectView
      >[0])
    })
    expect(result.current.state.type).toBe('object-view')

    act(() => {
      result.current.showSideview('document', 'file-1:a.pdf')
    })
    expect(result.current.state.type).toBe('sideview')
  })
})

describe('summary action subscription', () => {
  test('does not render action-only consumers when the side panel changes', () => {
    const renderAction = mock()
    const Action = memo(() => {
      const show = useShowCompactionSummary()
      renderAction()
      return <button onClick={() => show({ summary: 'Saved', retainedTail: [] })}>Summary</button>
    })
    const Panel = () => {
      const { state, close } = useContentView()
      return <button onClick={close}>{state.type ?? 'Closed'}</button>
    }
    const view = render(
      <ContentViewProvider>
        <Action />
        <Panel />
      </ContentViewProvider>,
    )
    const initialRenders = renderAction.mock.calls.length
    fireEvent.click(view.getByText('Summary'))
    expect(view.getByText('compaction-summary')).toBeTruthy()
    fireEvent.click(view.getByText('compaction-summary'))
    expect(view.getByText('Closed')).toBeTruthy()
    expect(renderAction).toHaveBeenCalledTimes(initialRenders)
  })
})

describe('browser panel reopening', () => {
  beforeEach(() => usePageStore.setState({ sessions: [], activeId: null }))
  afterEach(() => usePageStore.setState({ sessions: [], activeId: null }))

  test('reopens the newest remaining browser tab when no active selection remains', () => {
    const store = usePageStore.getState()
    store.ensure({ id: 'first', title: 'First', source: { kind: 'url', url: 'https://example.com/first' } })
    const latest = store.ensure({
      id: 'latest',
      title: 'Latest',
      source: { kind: 'url', url: 'https://example.com/latest' },
    })
    store.ensure(
      { id: 'graphic', title: 'Graphic', source: { kind: 'html', html: '<svg />' } },
      { presentation: 'inline' },
    )
    usePageStore.setState({ activeId: null })
    const { result } = renderHook(() => usePreviewControls(), { wrapper })
    act(() => result.current!.showBrowser())
    expect(result.current?.isPreviewOpen).toBe(true)
    expect(usePageStore.getState().activeId).toBe(latest)
    expect(usePageStore.getState().sessions).toHaveLength(3)
  })

  test('creates a blank tab only when the remaining documents are inline', () => {
    const inline = usePageStore
      .getState()
      .ensure(
        { id: 'graphic', title: 'Graphic', source: { kind: 'html', html: '<svg />' } },
        { presentation: 'inline' },
      )
    const { result } = renderHook(() => usePreviewControls(), { wrapper })
    act(() => result.current!.showBrowser())
    const { sessions, activeId } = usePageStore.getState()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((session) => session.id === inline)?.presentation).toBe('inline')
    expect(sessions.find((session) => session.id === activeId)?.page.source).toEqual({
      kind: 'url',
      url: 'about:blank',
    })
  })
})
