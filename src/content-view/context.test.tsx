/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { describe, expect, test } from 'bun:test'
import { type ReactNode } from 'react'
import { ContentViewProvider, type ObjectViewContent, useContentView, useObjectView, useSideview } from './context'

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
    const { result } = renderHook(() => useObjectView(), { wrapper })

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
