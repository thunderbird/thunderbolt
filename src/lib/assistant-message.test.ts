import { describe, expect, it } from 'bun:test'
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
import { filterMessageParts, groupToolParts } from './assistant-message'

const createToolPart = (toolName: string): ToolUIPart =>
  ({
    type: `tool-${toolName}`,
    toolCallId: `${toolName}-call`,
    state: 'output-available',
    input: { value: toolName },
    output: { value: toolName },
  }) as unknown as ToolUIPart

describe('assistant-message utilities', () => {
  describe('groupToolParts', () => {
    it('groups consecutive non-display tool parts into a single group entry', () => {
      const toolAlpha = createToolPart('alpha')
      const toolBeta = createToolPart('beta')
      const textPart: TextUIPart = { type: 'text', text: 'hello' }

      const parts = [toolAlpha, toolBeta, textPart]

      const grouped = groupToolParts(parts)

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'group_tools',
        tools: [toolAlpha, toolBeta],
        parts: [toolAlpha, toolBeta],
      })
      expect(grouped[1]).toBe(textPart)
    })

    it('flushes groups when encountering non-tool or display-only tools', () => {
      const displayTool = createToolPart('display-panel')
      const regularTool = createToolPart('gamma')
      const trailingTool = createToolPart('delta')
      const reasoningPart: ReasoningUIPart = { type: 'reasoning', text: 'because' }

      const grouped = groupToolParts([displayTool, regularTool, reasoningPart, trailingTool])

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toBe(displayTool)
      expect(grouped[1]).toEqual({
        type: 'group_tools',
        tools: [regularTool, trailingTool],
        parts: [regularTool, reasoningPart, trailingTool],
      })
    })

    it('groups reasoning and tools together in the same group', () => {
      const reasoningPart1: ReasoningUIPart = { type: 'reasoning', text: 'thinking first' }
      const toolAlpha = createToolPart('alpha')
      const reasoningPart2: ReasoningUIPart = { type: 'reasoning', text: 'thinking second' }
      const toolBeta = createToolPart('beta')
      const toolGamma = createToolPart('gamma')
      const textPart: TextUIPart = { type: 'text', text: 'response' }

      const parts = [reasoningPart1, toolAlpha, reasoningPart2, toolBeta, toolGamma, textPart]

      const grouped = groupToolParts(parts)

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'group_tools',
        tools: [toolAlpha, toolBeta, toolGamma],
        parts: [reasoningPart1, toolAlpha, reasoningPart2, toolBeta, toolGamma],
      })
      expect(grouped[1]).toBe(textPart)
    })

    it('handles reasoning parts without tools', () => {
      const reasoningPart1: ReasoningUIPart = { type: 'reasoning', text: 'thinking first' }
      const reasoningPart2: ReasoningUIPart = { type: 'reasoning', text: 'thinking second' }
      const textPart: TextUIPart = { type: 'text', text: 'response' }

      const parts = [reasoningPart1, reasoningPart2, textPart]

      const grouped = groupToolParts(parts)

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'group_tools',
        tools: [],
        parts: [reasoningPart1, reasoningPart2],
      })
      expect(grouped[1]).toBe(textPart)
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
