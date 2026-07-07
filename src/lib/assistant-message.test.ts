/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DynamicToolUIPart, ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai'
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

// MCP tools arrive as `dynamic-tool` parts (tool name in `toolName`, not the part type).
const createDynamicToolPart = (toolName: string): DynamicToolUIPart =>
  ({
    type: 'dynamic-tool',
    toolName,
    toolCallId: `${toolName}-call`,
    state: 'output-available',
    input: { value: toolName },
    output: { value: toolName },
  }) as unknown as DynamicToolUIPart

const createArtifactPart = (id: string, output: { ok: boolean; errors?: string[]; target?: string }): ToolUIPart =>
  ({
    type: 'tool-render_html',
    toolCallId: id,
    state: 'output-available',
    input: { html: '<h1>x</h1>', title: 'A' },
    output,
  }) as unknown as ToolUIPart

const createExecutingArtifactPart = (id: string): ToolUIPart =>
  ({
    type: 'tool-render_html',
    toolCallId: id,
    state: 'input-available',
    input: { html: '<h1>x</h1>', title: 'A' },
  }) as unknown as ToolUIPart

const createPendingArtifactPart = (id: string): ToolUIPart =>
  ({
    type: 'tool-render_html',
    toolCallId: id,
    state: 'input-streaming',
    input: { title: 'A' },
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

    it('groups MCP dynamic-tool parts as tool items alongside typed tool parts', () => {
      const typedTool = createToolPart('search')
      const mcpTool = createDynamicToolPart('render_list_services')

      const grouped = groupMessageParts([typedTool, mcpTool])

      expect(grouped).toHaveLength(1)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [
          { type: 'tool', content: typedTool, id: typedTool.toolCallId },
          { type: 'tool', content: mcpTool, id: mcpTool.toolCallId },
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

  describe('groupMessageParts — render_html artifacts', () => {
    it('lifts a verified artifact out of the tool group as a standalone part', () => {
      const grep = createToolPart('grep')
      const artifact = createArtifactPart('a1', { ok: true, target: 'inline' })

      const grouped = groupMessageParts([grep, artifact])

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [{ type: 'tool', content: grep, id: grep.toolCallId }],
      })
      expect(grouped[1]).toBe(artifact)
    })

    it('lifts out a still-streaming artifact once it has HTML, for a live preview', () => {
      const executing = createExecutingArtifactPart('a1')

      expect(groupMessageParts([executing])).toEqual([executing])
    })

    it('lifts out a not-yet-started artifact so the card can show immediately', () => {
      const pending = createPendingArtifactPart('a1')

      expect(groupMessageParts([pending])).toEqual([pending])
    })

    it('keeps a failed attempt in the group and lifts out only the successful retry', () => {
      const failed = createArtifactPart('a1', { ok: false, errors: ['boom'] })
      const succeeded = createArtifactPart('a2', { ok: true, target: 'inline' })

      const grouped = groupMessageParts([failed, succeeded])

      expect(grouped).toHaveLength(2)
      expect(grouped[0]).toEqual({
        type: 'reasoning_group',
        items: [{ type: 'tool', content: failed, id: failed.toolCallId }],
      })
      expect(grouped[1]).toBe(succeeded)
    })

    it('keeps a lone failed attempt as an ordinary tool call', () => {
      const failed = createArtifactPart('a1', { ok: false, errors: ['boom'] })

      expect(groupMessageParts([failed])).toEqual([
        { type: 'reasoning_group', items: [{ type: 'tool', content: failed, id: failed.toolCallId }] },
      ])
    })

    it('keeps two distinct verified artifacts', () => {
      const first = createArtifactPart('a1', { ok: true, target: 'inline' })
      const second = createArtifactPart('a2', { ok: true, target: 'panel' })

      expect(groupMessageParts([first, second])).toEqual([first, second])
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

    it('keeps MCP dynamic-tool parts instead of dropping them', () => {
      const mcpTool = createDynamicToolPart('render_list_services')
      const textPart: TextUIPart = { type: 'text', text: 'output' }

      const filtered = filterMessageParts([textPart, mcpTool] as UIMessage['parts'])

      expect(filtered).toEqual([textPart, mcpTool])
    })
  })
})
