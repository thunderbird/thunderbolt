/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { GroupedUIPart, ReasoningGroupUIPart } from '@/lib/assistant-message'
import type { ThunderboltUIMessage } from '@/types'
import type { ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { ContentViewProvider } from '@/content-view/context'
import { AssistantMessage, mountMessageParts } from './assistant-message'

const createReasoningPart = (text: string): ReasoningUIPart =>
  ({
    type: 'reasoning',
    text,
  }) as ReasoningUIPart

const createTextPart = (text: string): TextUIPart =>
  ({
    type: 'text',
    text,
  }) as TextUIPart

const createToolPart = (state: ToolUIPart['state'], toolName = 'search'): ToolUIPart =>
  ({
    type: `tool:${toolName}`,
    toolCallId: `call-${Math.random()}`,
    state,
    input: {},
    output: state === 'output-available' ? { result: 'data' } : undefined,
  }) as unknown as ToolUIPart

const createReasoningGroupPart = (
  items: Array<{ type: 'reasoning' | 'tool'; content: ReasoningUIPart | ToolUIPart; id: string }>,
): ReasoningGroupUIPart =>
  ({
    type: 'reasoning_group',
    items,
  }) as ReasoningGroupUIPart

const createToolGroupPart = (tools: ToolUIPart[]): ReasoningGroupUIPart =>
  createReasoningGroupPart(tools.map((tool) => ({ type: 'tool' as const, content: tool, id: tool.toolCallId })))

describe('mountMessageParts', () => {
  const testMessageId = 'test-message-id'
  const testReasoningTime: Record<string, number> = {}

  describe('empty parts', () => {
    it('leaves empty-message activity to the message container', () => {
      const result = mountMessageParts([], true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(0)
    })
  })

  describe('reasoning parts', () => {
    it('renders reasoning part', () => {
      const reasoningPart = createReasoningPart('Let me think about this...')
      const parts: GroupedUIPart[] = [
        createReasoningGroupPart([{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]),
      ]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      expect(result[0]).toBeDefined()
    })
  })

  describe('text parts', () => {
    it('renders text part', () => {
      const parts: GroupedUIPart[] = [createTextPart('Hello world')]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      expect(result[0]).toBeDefined()
    })

    it('detects text part presence for tool group logic', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup, createTextPart('Response text')]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(2)
      // Both parts should be rendered
      expect(result[0]).toBeDefined()
      expect(result[1]).toBeDefined()
    })
  })

  describe('tool groups', () => {
    it('renders tool group with single tool', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      expect(result[0]).toBeDefined()
    })

    it('renders tool group with multiple tools', () => {
      const toolGroup = createToolGroupPart([
        createToolPart('output-available', 'search'),
        createToolPart('output-available', 'fetch_content'),
        createToolPart('output-available', 'get_weather'),
      ])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      expect(result[0]).toBeDefined()
    })

    it('passes isStreaming prop to tool group', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup]
      const streamingResult = mountMessageParts(parts, true, testMessageId, testReasoningTime)
      const notStreamingResult = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(streamingResult[0]).toBeDefined()
      expect(notStreamingResult[0]).toBeDefined()
      // Both should render but with different props
    })

    it('correctly identifies last part in message', () => {
      const toolGroup1 = createToolGroupPart([createToolPart('output-available')])
      const toolGroup2 = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup1, toolGroup2]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(2)
      // Both tool groups should render
      expect(result[0]).toBeDefined()
      expect(result[1]).toBeDefined()
    })

    it('passes hasTextInMessage flag when text part exists', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup, createTextPart('Some text')]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(2)
    })

    it('does not set hasTextInMessage when only tools exist', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
    })
  })

  describe('mixed part types', () => {
    it('renders multiple different part types in order', () => {
      const reasoningPart = createReasoningPart('Thinking...')
      const parts: GroupedUIPart[] = [
        createReasoningGroupPart([{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]),
        createToolGroupPart([createToolPart('output-available')]),
        createTextPart('Here is the result'),
      ]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(3)
      expect(result[0]).toBeDefined()
      expect(result[1]).toBeDefined()
      expect(result[2]).toBeDefined()
    })

    it('handles complex message with reasoning, tools, and text', () => {
      const reasoningPart = createReasoningPart('Let me search for that')
      const parts: GroupedUIPart[] = [
        createReasoningGroupPart([{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]),
        createToolGroupPart([
          createToolPart('output-available', 'search'),
          createToolPart('output-available', 'fetch_content'),
        ]),
        createTextPart('Based on the search results, I found...'),
      ]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(3)
    })

    it('handles message with only reasoning and text (no tools)', () => {
      const reasoningPart = createReasoningPart('Thinking...')
      const parts: GroupedUIPart[] = [
        createReasoningGroupPart([{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]),
        createTextPart('Direct answer'),
      ]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(2)
    })
  })

  describe('streaming states', () => {
    it('handles streaming message with incomplete tools', () => {
      const toolGroup = createToolGroupPart([
        createToolPart('output-available'),
        createToolPart('input-streaming'), // Still loading
      ])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
    })

    it('handles streaming message with completed tools but no text yet', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available'), createToolPart('output-available')])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      // Should show loading indicator for next action
    })

    it('handles non-streaming message with all parts complete', () => {
      const parts: GroupedUIPart[] = [
        createToolGroupPart([createToolPart('output-available')]),
        createTextPart('Complete response'),
      ]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    it('handles tool group with errored tools', () => {
      const toolGroup = createToolGroupPart([createToolPart('output-available'), createToolPart('output-error')])
      const parts: GroupedUIPart[] = [toolGroup]
      const result = mountMessageParts(parts, true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
    })

    it('handles message with only reasoning', () => {
      const reasoningPart = createReasoningPart('Just thinking out loud...')
      const parts: GroupedUIPart[] = [
        createReasoningGroupPart([{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]),
      ]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
    })

    it('handles message with only tools (no text or reasoning)', () => {
      const parts: GroupedUIPart[] = [createToolGroupPart([createToolPart('output-available')])]
      const result = mountMessageParts(parts, false, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
    })
  })
})

describe('AssistantMessage activity', () => {
  it('keeps activity visible after commentary and removes it when the turn settles', () => {
    const message: ThunderboltUIMessage = {
      id: 'working',
      role: 'assistant',
      parts: [
        { type: 'tool-bash', toolCallId: 'inspect', state: 'output-available', input: {}, output: 'Done' },
        { type: 'text', text: 'Now writing the new game.', state: 'done' },
      ],
    }
    const { rerender } = render(<AssistantMessage message={message} isStreaming />, { wrapper: ContentViewProvider })
    expect(screen.getByText('Now writing the new game.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expect(screen.getAllByTestId('loading-status')).toHaveLength(1)

    rerender(<AssistantMessage message={message} isStreaming={false} />)
    expect(screen.queryByTestId('loading-status')).toBeNull()
    cleanup()
  })

  it('shows activity while a sidebar artifact is being generated without adding an inline widget', () => {
    const message: ThunderboltUIMessage = {
      id: 'generating-page',
      role: 'assistant',
      parts: [
        { type: 'tool-render_html', toolCallId: 'page', state: 'input-streaming', input: { presentation: 'sidebar' } },
      ],
    }
    render(<AssistantMessage message={message} isStreaming />)
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expect(screen.queryByText('Show inline')).toBeNull()
    cleanup()
  })

  it('uses the active tool group instead of showing a second spinner', () => {
    const message: ThunderboltUIMessage = {
      id: 'tools',
      role: 'assistant',
      parts: [{ type: 'tool-bash', toolCallId: 'run', state: 'input-available', input: {} }],
    }
    const { container } = render(<AssistantMessage message={message} isStreaming />, { wrapper: ContentViewProvider })
    expect(screen.queryByTestId('loading-status')).toBeNull()
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1)
    cleanup()
  })

  it('shows one status for an empty stream and yields to compaction activity', () => {
    const message: ThunderboltUIMessage = { id: 'empty', role: 'assistant', parts: [] }
    const { rerender } = render(<AssistantMessage message={message} isStreaming />)
    expect(screen.getAllByTestId('loading-status')).toHaveLength(1)
    rerender(<AssistantMessage message={message} isStreaming activity={<div role="status">Compacting…</div>} />)
    expect(screen.queryByTestId('loading-status')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Compacting…')
    cleanup()
  })

  it('pauses reasoning activity during compaction and clears stale streaming parts after stopping', () => {
    const message: ThunderboltUIMessage = {
      id: 'thinking',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'Planning the game.', state: 'streaming' }],
    }
    const { container, rerender } = render(<AssistantMessage message={message} isStreaming />, {
      wrapper: ContentViewProvider,
    })
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1)
    rerender(<AssistantMessage message={message} isStreaming activity={<div role="status">Compacting…</div>} />)
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('Compacting…')
    rerender(<AssistantMessage message={message} isStreaming />)
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1)
    rerender(<AssistantMessage message={message} isStreaming={false} />)
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0)
    cleanup()
  })

  it.each(['in_progress', 'completed'] as const)('resumes activity after remote compaction (%s)', (status) => {
    const message: ThunderboltUIMessage = {
      id: 'compacting',
      role: 'assistant',
      parts: [{ type: 'data-acp-compaction', data: { agentId: 'agent', sessionId: 's', compactionId: 'c', status } }],
    }
    render(
      <ContentViewProvider>
        <AssistantMessage message={message} isStreaming />
      </ContentViewProvider>,
    )
    expect(screen.queryByTestId('loading-status') !== null).toBe(status === 'completed')
    cleanup()
  })
})

describe('AssistantMessage actions', () => {
  it('renders the last-assistant action beside the copy button', () => {
    const message: ThunderboltUIMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Response' }],
    }

    render(
      <AssistantMessage
        message={message}
        isStreaming={false}
        isLastAssistantMessage
        lastAssistantAction={<button type="button">Share transcript</button>}
      />,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    const shareButton = screen.getByRole('button', { name: 'Share transcript' })
    expect(copyButton.parentElement).toBe(shareButton.parentElement)

    cleanup()
  })
})

it('passes message streaming lifecycle to the real text renderer', () => {
  const text = 'Full response. '.repeat(100)
  const parts: GroupedUIPart[] = [{ type: 'text', text, state: 'streaming' }]
  const { container, rerender } = render(<>{mountMessageParts(parts, true, 'stream', {})}</>)
  expect(container.textContent).toBe('')
  act(() => getClock().tick(48))
  expect(container.textContent!.length).toBeGreaterThan(0)
  expect(container.textContent!.length).toBeLessThan(text.length)
  rerender(<>{mountMessageParts(parts, false, 'stream', {})}</>)
  expect(container.textContent).toBe(text.trim())
})

it('renders an ACP compaction row between the surrounding assistant text', () => {
  const message: ThunderboltUIMessage = {
    id: 'remote',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Before compaction' },
      {
        type: 'data-acp-compaction',
        id: 'event',
        data: { agentId: 'agent', sessionId: 's', compactionId: 'c', status: 'completed' },
      },
      { type: 'text', text: 'After compaction' },
    ],
  }
  const { container } = render(
    <ContentViewProvider>
      <AssistantMessage message={message} isStreaming={false} />
    </ContentViewProvider>,
  )
  expect(container.textContent).toContain('Before compactionCompactedAfter compaction')
  cleanup()
})
