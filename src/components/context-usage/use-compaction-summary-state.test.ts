/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import type { ThunderboltUIMessage } from '@/types'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { useCompactionSummaryState } from './use-compaction-summary-state'

/** A persisted message carrying a compaction boundary. */
const checkpointMessage = (summary: string): ThunderboltUIMessage => ({
  id: summary,
  role: 'assistant',
  parts: [],
  metadata: {
    contextCompaction: { version: 1, summary, tokensBefore: 8_000, contextTokens: 2_000, retainedTail: [] },
  },
})

const wrapper = ({ children }: { children: ReactNode }) => createElement(ContentViewProvider, null, children)

afterEach(cleanup)

describe('useCompactionSummaryState', () => {
  it('offers no viewer until a saved checkpoint exists', () => {
    const { result } = renderHook(() => useCompactionSummaryState([]), { wrapper })
    expect(result.current.onViewSummary).toBeUndefined()
  })

  it('opens the latest checkpoint and keeps the displayed snapshot stable until reopened', () => {
    const messages = [checkpointMessage('Earlier'), checkpointMessage('Latest')]
    const { result, rerender } = renderHook(
      ({ messages }) => ({
        summary: useCompactionSummaryState(messages),
        sidebar: useContentView(),
      }),
      { initialProps: { messages }, wrapper },
    )
    act(() => result.current.summary.onViewSummary!())
    expect(result.current.sidebar.state).toEqual({
      type: 'compaction-summary',
      data: messages[1].metadata!.contextCompaction!,
    })
    rerender({ messages: [...messages, checkpointMessage('New checkpoint')] })
    expect(result.current.sidebar.state).toEqual({
      type: 'compaction-summary',
      data: messages[1].metadata!.contextCompaction!,
    })
    act(() => result.current.sidebar.close())
    expect(result.current.sidebar.isOpen).toBe(false)
    act(() => result.current.summary.onViewSummary!())
    expect(result.current.sidebar.state).toEqual({
      type: 'compaction-summary',
      data: checkpointMessage('New checkpoint').metadata!.contextCompaction!,
    })
  })

  it('shares a single inspection panel with tool and reasoning views', () => {
    const { result } = renderHook(
      () => ({ summary: useCompactionSummaryState([checkpointMessage('Saved')]), sidebar: useContentView() }),
      { wrapper },
    )
    act(() => result.current.sidebar.showObjectView({ type: 'reasoning', text: 'Thinking', state: 'done' }))
    expect(result.current.sidebar.state.type).toBe('object-view')
    act(() => result.current.summary.onViewSummary!())
    expect(result.current.sidebar.state.type).toBe('compaction-summary')
    act(() => result.current.sidebar.showObjectView({ type: 'reasoning', text: 'Other reasoning', state: 'done' }))
    expect(result.current.sidebar.state.type).toBe('object-view')
  })
})

it('inspects the latest available remote summary without treating it as a Pi checkpoint', () => {
  const remote: ThunderboltUIMessage = {
    id: 'remote',
    role: 'assistant',
    parts: [
      {
        type: 'data-acp-compaction',
        id: 'first',
        data: {
          agentId: 'agent',
          sessionId: 's',
          compactionId: 'first',
          status: 'completed',
          summary: [{ type: 'text', text: 'Earlier ACP summary' }],
        },
      },
      {
        type: 'data-acp-compaction',
        id: 'second',
        data: {
          agentId: 'agent',
          sessionId: 's',
          compactionId: 'second',
          status: 'completed',
          summary: [{ type: 'text', text: 'Latest ACP summary' }],
        },
      },
      {
        type: 'data-acp-compaction',
        id: 'third',
        data: { agentId: 'agent', sessionId: 's', compactionId: 'third', status: 'in_progress' },
      },
    ],
  }
  const { result, rerender } = renderHook(
    ({ messages }) => ({ summary: useCompactionSummaryState(messages), sidebar: useContentView() }),
    { initialProps: { messages: [checkpointMessage('Pi summary'), remote] }, wrapper },
  )
  act(() => result.current.summary.onViewSummary!())
  expect(result.current.sidebar.state).toEqual({ type: 'compaction-summary', data: { summary: 'Latest ACP summary' } })
  expect(remote.metadata?.contextCompaction).toBeUndefined()
  rerender({ messages: [remote, checkpointMessage('New Pi summary')] })
  act(() => result.current.summary.onViewSummary!())
  expect(result.current.sidebar.state).toEqual({
    type: 'compaction-summary',
    data: checkpointMessage('New Pi summary').metadata!.contextCompaction!,
  })
})
