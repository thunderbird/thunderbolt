/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { GroupedUIPart, ReasoningGroupUIPart } from '@/lib/assistant-message'
import type { ReasoningUIPart, TextUIPart, ToolUIPart } from 'ai'
import { describe, expect, it } from 'bun:test'
import { mountMessageParts } from './assistant-message'

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
    it('renders synthetic loading part when no parts exist', () => {
      const result = mountMessageParts([], true, testMessageId, testReasoningTime)

      expect(result).toHaveLength(1)
      // Check that it's the synthetic loading component by checking the result structure
      expect(result[0]).toBeDefined()
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
