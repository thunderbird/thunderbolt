/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { filterMessageParts, groupMessageParts } from './assistant-message'

const createToolPart = (toolName: string): ToolUIPart =>
  ({
    type: `tool-${toolName}`,
    toolCallId: `${toolName}-call`,
    state: 'output-available',
    input: { value: toolName },
    output: { value: toolName },
  }) as unknown as ToolUIPart

describe('assistant-message utilities', () => {
  describe('groupMessageParts', () => {
    it('groups consecutive tool parts into a single reasoning_group entry', () => {
      const toolAlpha = createToolPart('alpha')
      const toolBeta = createToolPart('beta')
      const textPart: TextUIPart = { type: 'text', text: 'hello' }

      const parts = [toolAlpha, toolBeta, textPart]

      const grouped = groupMessageParts(parts)

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [
          { type: 'tool', content: toolAlpha, id: toolAlpha.toolCallId },
          { type: 'tool', content: toolBeta, id: toolBeta.toolCallId },
        ],
      })
      expect(grouped[1]).toBe(textPart)
    })

    it('groups reasoning parts together with tools', () => {
      const toolAlpha = createToolPart('alpha')
      const toolBeta = createToolPart('beta')
      const reasoningPart: ReasoningUIPart = { type: 'reasoning', text: 'because' }
      const toolGamma = createToolPart('gamma')

      const grouped = groupMessageParts([toolAlpha, toolBeta, reasoningPart, toolGamma])

      expect(grouped).toHaveLength(1)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [
          { type: 'tool', content: toolAlpha, id: toolAlpha.toolCallId },
          { type: 'tool', content: toolBeta, id: toolBeta.toolCallId },
          { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' },
          { type: 'tool', content: toolGamma, id: toolGamma.toolCallId },
        ],
      })
    })

    it('flushes groups when encountering text parts', () => {
      const toolAlpha = createToolPart('alpha')
      const toolBeta = createToolPart('beta')
      const textPart: TextUIPart = { type: 'text', text: 'hello' }
      const toolGamma = createToolPart('gamma')

      const grouped = groupMessageParts([toolAlpha, toolBeta, textPart, toolGamma])

      expect(grouped).toHaveLength(3)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [
          { type: 'tool', content: toolAlpha, id: toolAlpha.toolCallId },
          { type: 'tool', content: toolBeta, id: toolBeta.toolCallId },
        ],
      })
      expect(grouped[1]).toBe(textPart)
      expect(grouped[2]).toEqual({
        type: 'reasoning_group',
        items: [{ type: 'tool', content: toolGamma, id: toolGamma.toolCallId }],
      })
    })
  })

  describe('filterMessageParts', () => {
    it('retains supported parts and prunes unsupported or empty text entries', () => {
      const textPart: TextUIPart = { type: 'text', text: 'assistant output' }
      const emptyTextPart: TextUIPart = { type: 'text', text: '   ' }
      const reasoningPart: ReasoningUIPart = { type: 'reasoning', text: 'thinking' }
      const toolPart = createToolPart('epsilon')
      const unsupportedPart = {
        type: 'source-url',
        sourceId: 'doc-1',
        url: 'https://example.com',
      } as unknown as UIMessage['parts'][number]

      const parts = [textPart, emptyTextPart, reasoningPart, toolPart, unsupportedPart] as UIMessage['parts']

      const filtered = filterMessageParts(parts)

      expect(filtered).toEqual([textPart, reasoningPart, toolPart])
    })
  })
})
