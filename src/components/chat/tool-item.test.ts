/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolUIPart } from 'ai'
import { describe, expect, it, mock } from 'bun:test'
import { useToolItemState } from './tool-item'

// Mock the dependencies
mock.module('@/lib/tool-metadata', () => ({
  getToolMetadataSync: mock((toolName: string) => ({
    displayName: `${toolName} Display`,
    icon: null,
    initials: toolName.slice(0, 2).toUpperCase(),
    loadingMessage: `Loading ${toolName}...`,
    category: 'unknown' as const,
  })),
}))

const createMockTool = (
  state: ToolUIPart['state'],
  output?: unknown,
  toolCallId?: string,
  type = 'tool-test_tool',
): ToolUIPart =>
  ({
    type,
    state,
    output,
    toolCallId,
    input: {},
  }) as ToolUIPart

describe('useToolItemState', () => {
  it('correctly identifies loading state when tool has not completed', () => {
    const tool = createMockTool('input-streaming')
    const result = useToolItemState({ tool, index: 0 })

    expect(result.isLoading).toBe(true)
    expect(result.isError).toBe(false)
  })

  it('correctly identifies loading state when tool has no output', () => {
    const tool = createMockTool('output-available', undefined)
    const result = useToolItemState({ tool, index: 0 })

    expect(result.isLoading).toBe(true)
    expect(result.isError).toBe(false)
  })

  it('correctly identifies completed state', () => {
    const tool = createMockTool('output-available', { result: 'success' })
    const result = useToolItemState({ tool, index: 0 })

    expect(result.isLoading).toBe(false)
    expect(result.isError).toBe(false)
  })

  it('correctly identifies error state', () => {
    const tool = createMockTool('output-error')
    const result = useToolItemState({ tool, index: 0 })

    expect(result.isLoading).toBe(false)
    expect(result.isError).toBe(true)
  })

  it('uses toolCallId for tooltip key when available', () => {
    const tool = createMockTool('output-available', { result: 'success' }, 'unique-call-id')
    const result = useToolItemState({ tool, index: 5 })

    expect(result.tooltipKey).toBe('unique-call-id')
  })

  it('generates fallback tooltip key from toolName and index', () => {
    const tool = createMockTool('output-available', { result: 'success' }, undefined, 'tool-search')
    const result = useToolItemState({ tool, index: 3 })

    expect(result.tooltipKey).toBe('search-3')
  })

  it('extracts tool name from type string', () => {
    const tool = createMockTool('output-available', { result: 'success' }, undefined, 'tool-fetch_content')
    const result = useToolItemState({ tool, index: 0 })

    expect(result.toolName).toBe('fetch_content')
  })

  it('returns metadata from getToolMetadataSync', () => {
    const tool = createMockTool('output-available', { result: 'success' })
    const result = useToolItemState({ tool, index: 0 })

    expect(result.metadata).toEqual({
      displayName: 'test_tool Display',
      icon: null,
      initials: 'TE',
      loadingMessage: 'Loading test_tool...',
      category: 'unknown',
    })
  })
})
