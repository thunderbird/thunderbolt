/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReasoningGroupItem } from '@/lib/assistant-message'
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { describe, expect, it, mock } from 'bun:test'
import { ReasoningItem } from './reasoning-item'

const createMockReasoningPart = (state: 'streaming' | 'complete' = 'complete', duration?: number): ReasoningUIPart => {
  const part = {
    type: 'reasoning',
    text: 'Let me think about this...',
    state,
  } as ReasoningUIPart

  if (duration !== undefined) {
    ;(part as ReasoningUIPart & { metadata?: { duration: number } }).metadata = { duration }
  }

  return part
}

const createMockToolPart = (
  toolName: string,
  state: ToolUIPart['state'] = 'output-available',
  duration?: number,
): ToolUIPart => {
  const part = {
    type: `tool-${toolName}`,
    toolCallId: `call-${toolName}-${Math.random()}`,
    state,
    input: {},
    output: state === 'output-available' ? { result: 'data' } : undefined,
  } as unknown as ToolUIPart

  if (duration !== undefined) {
    ;(part as ToolUIPart & { metadata?: { duration: number } }).metadata = { duration }
  }

  return part
}

describe('ReasoningItem', () => {
  const testReasoningTime = 1000

  describe('reasoning type', () => {
    it('should render reasoning item with "Thinking" label', () => {
      const reasoningPart = createMockReasoningPart()
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      expect(screen.getByText('Thinking')).toBeInTheDocument()
    })

    it('should render Brain icon when not loading', () => {
      const reasoningPart = createMockReasoningPart('complete')
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      // Check that Brain icon is rendered (it's an SVG, so we check for the button)
      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
      // The icon should be present (not the loader)
      expect(button.querySelector('svg')).toBeInTheDocument()
    })

    it('should render loader when reasoning is streaming', () => {
      const reasoningPart = createMockReasoningPart('streaming')
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning />)

      // Check for loader (Loader2 has animate-spin class)
      const button = screen.getByRole('button')
      const loader = button.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })

    it('should display duration when available', () => {
      const reasoningPart = createMockReasoningPart('complete', 1500)
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} reasoningTime={1500} isGroupReasoning={false} />)

      // formatDuration(1500) should format to something like "1.5s"
      expect(screen.getByText(/1\.5s|1s/i)).toBeInTheDocument()
    })

    it('should display "..." when loading and no duration', () => {
      const reasoningPart = createMockReasoningPart('streaming')
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} isGroupReasoning />)

      expect(screen.getByText('...')).toBeInTheDocument()
    })

    it('should display "—" when not loading and no duration', () => {
      const reasoningPart = createMockReasoningPart('complete')
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} isGroupReasoning={false} />)

      expect(screen.getByText('—')).toBeInTheDocument()
    })

    it('should call onClick when clicked', () => {
      const reasoningPart = createMockReasoningPart()
      const part: ReasoningGroupItem = { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      const button = screen.getByRole('button')
      fireEvent.click(button)

      expect(mockOnClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('tool type', () => {
    it('should render tool item with display name from metadata', () => {
      const toolPart = createMockToolPart('search')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      // The display name comes from getToolMetadataSync which formats the tool name
      // For 'search', it should format to something like "Search"
      expect(screen.getByText(/search/i)).toBeInTheDocument()
    })

    it('should render tool icon when not loading', () => {
      const toolPart = createMockToolPart('test_tool', 'output-available')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
      // Icon should be present (not the loader)
      expect(button.querySelector('svg')).toBeInTheDocument()
    })

    it('should render loader when tool is loading', () => {
      const toolPart = createMockToolPart('test_tool', 'input-streaming')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning />)

      const button = screen.getByRole('button')
      const loader = button.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })

    it('should render loader when tool state is not output-available or output-error', () => {
      const toolPart = createMockToolPart('test_tool', 'input-available')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning />)

      const button = screen.getByRole('button')
      const loader = button.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })

    it('should not render loader when tool state is output-available', () => {
      const toolPart = createMockToolPart('test_tool', 'output-available')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      const button = screen.getByRole('button')
      const loader = button.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })

    it('should not render loader when tool state is output-error', () => {
      const toolPart = createMockToolPart('test_tool', 'output-error')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      const button = screen.getByRole('button')
      const loader = button.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })

    it('should display duration when available', () => {
      const toolPart = createMockToolPart('test_tool', 'output-available', 2500)
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} reasoningTime={2500} isGroupReasoning={false} />)

      // formatDuration(2500) should format to something like "2.5s"
      expect(screen.getByText(/2\.5s|2s/i)).toBeInTheDocument()
    })

    it('should display "..." when loading and no duration', () => {
      const toolPart = createMockToolPart('test_tool', 'input-streaming')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} isGroupReasoning />)

      expect(screen.getByText('...')).toBeInTheDocument()
    })

    it('should display "—" when not loading and no duration', () => {
      const toolPart = createMockToolPart('test_tool', 'output-available')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(<ReasoningItem part={part} onClick={mockOnClick} isGroupReasoning={false} />)

      expect(screen.getByText('—')).toBeInTheDocument()
    })

    it('should call onClick when clicked', () => {
      const toolPart = createMockToolPart('test_tool', 'output-available')
      const part: ReasoningGroupItem = { type: 'tool', content: toolPart, id: toolPart.toolCallId }
      const mockOnClick = mock()

      render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      const button = screen.getByRole('button')
      fireEvent.click(button)

      expect(mockOnClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('edge cases', () => {
    it('should return null for unknown part type', () => {
      const part = { type: 'unknown' as 'tool' | 'reasoning', content: {}, id: 'unknown-0' } as ReasoningGroupItem
      const mockOnClick = mock()

      const { container } = render(
        <ReasoningItem part={part} onClick={mockOnClick} reasoningTime={testReasoningTime} isGroupReasoning={false} />,
      )

      expect(container.firstChild).toBeNull()
    })
  })
})
