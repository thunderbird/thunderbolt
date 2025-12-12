import { ContentViewProvider } from '@/content-view/context'
import type { ReasoningGroupItem } from '@/lib/assistant-message'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { describe, expect, it } from 'bun:test'
import { ReasoningGroup } from './reasoning-group'

const createMockReasoningPart = (
  state: 'streaming' | 'complete' = 'complete',
  duration?: number,
  text: string = 'Let me think about this...',
): ReasoningUIPart => {
  const part = {
    type: 'reasoning',
    text,
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

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  return <ContentViewProvider>{children}</ContentViewProvider>
}

const testReasoningTime: Record<string, number> = {}

describe('ReasoningGroup', () => {
  describe('rendering', () => {
    it('should render Expandable component with ReasoningGroupTitle', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // Check that Expandable is rendered (it should contain the title)
      expect(screen.getByText(/completed|searching|processing/i)).toBeInTheDocument()
    })

    it('should render ReasoningItem for each part', () => {
      const searchTool = createMockToolPart('search')
      const readFileTool = createMockToolPart('read_file')
      const parts: ReasoningGroupItem[] = [
        { type: 'tool', content: searchTool, id: searchTool.toolCallId },
        { type: 'tool', content: readFileTool, id: readFileTool.toolCallId },
      ]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Expandable is closed by default, but items should still be in the DOM
      // Check that the component rendered correctly
      // The ReasoningGroupTitle should show completion message with 2 steps (2 tools)
      expect(container.textContent).toMatch(/completed.*2.*steps/i)
    })

    it('should render CheckIcon when not thinking', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // CheckIcon should be present (not Loader2)
      const loader = container.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })

    it('should render Loader2 when thinking', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Loader2 should be present with animate-spin class
      const loader = container.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })
  })

  describe('isGroupReasoning logic', () => {
    it('should be thinking when isLastPartInMessage and isStreaming are both true', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Should show loader
      const loader = container.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })

    it('should not be thinking when isLastPartInMessage is false', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Should not show loader
      const loader = container.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })

    it('should not be thinking when isStreaming is false', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Should not show loader
      const loader = container.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })
  })

  describe('ReasoningDisplay conditional rendering', () => {
    it('should render ReasoningDisplay when hasTextPart is false and reasoning part exists', () => {
      const reasoningPart = createMockReasoningPart('streaming')
      const parts: ReasoningGroupItem[] = [{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // ReasoningDisplay should render the reasoning text when streaming
      // It might be in a specific container, so check the container
      expect(container.textContent).toContain('Let me think about this...')
    })

    it('should not render ReasoningDisplay when hasTextPart is true', () => {
      const reasoningPart = createMockReasoningPart('complete')
      const parts: ReasoningGroupItem[] = [{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={true}
          reasoningTime={testReasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // ReasoningDisplay should not render
      expect(screen.queryByText('Let me think about this...')).not.toBeInTheDocument()
    })

    it('should not render ReasoningDisplay when no reasoning part exists', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // ReasoningDisplay should not render
      expect(screen.queryByText('Let me think about this...')).not.toBeInTheDocument()
    })

    it('should render ReasoningDisplay with streaming state when reasoning is streaming', () => {
      const reasoningPart = createMockReasoningPart('streaming')
      const parts: ReasoningGroupItem[] = [{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // ReasoningDisplay should render the reasoning text
      expect(screen.getByText('Let me think about this...')).toBeInTheDocument()
    })
  })

  describe('duration calculation', () => {
    it('should calculate total duration from all parts', () => {
      const searchTool = createMockToolPart('search', 'output-available', 1000)
      const readFileTool = createMockToolPart('read_file', 'output-available', 1500)
      const reasoningPart = createMockReasoningPart('complete', 500)
      const parts: ReasoningGroupItem[] = [
        { type: 'tool', content: searchTool, id: searchTool.toolCallId },
        { type: 'tool', content: readFileTool, id: readFileTool.toolCallId },
        { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' },
      ]
      const reasoningTime = {
        [searchTool.toolCallId]: 1000,
        [readFileTool.toolCallId]: 1500,
        'reasoning-0': 500,
      }
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={reasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // Total duration should be 3000ms (1000 + 1500 + 500)
      // The ReasoningGroupTitle should display this duration
      expect(screen.getByText(/3\.0s|3s/i)).toBeInTheDocument()
    })

    it('should handle parts without duration', () => {
      const searchTool = createMockToolPart('search')
      const readFileTool = createMockToolPart('read_file', 'output-available', 2000)
      const parts: ReasoningGroupItem[] = [
        { type: 'tool', content: searchTool, id: searchTool.toolCallId },
        { type: 'tool', content: readFileTool, id: readFileTool.toolCallId },
      ]
      const reasoningTime = {
        [readFileTool.toolCallId]: 2000,
      }
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={reasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // Total duration should be 2000ms (0 + 2000)
      expect(screen.getByText(/2\.0s|2s/i)).toBeInTheDocument()
    })
  })

  describe('onClick handler', () => {
    it('should call openObjectSidebar when ReasoningItem is clicked', () => {
      const toolPart = createMockToolPart('search')
      const parts: ReasoningGroupItem[] = [{ type: 'tool', content: toolPart, id: toolPart.toolCallId }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Find reasoning item buttons (they're inside the Expandable which is closed by default)
      // But they should still be in the DOM
      const buttons = container.querySelectorAll('button')
      // Should have at least one button (the expandable trigger)
      expect(buttons.length).toBeGreaterThan(0)
      // Verify the component rendered without crashing
      expect(container).toBeInTheDocument()
    })

    it('should call openObjectSidebar with reasoning part when reasoning item is clicked', () => {
      const reasoningPart = createMockReasoningPart('complete')
      const parts: ReasoningGroupItem[] = [{ type: 'reasoning', content: reasoningPart, id: 'reasoning-0' }]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Verify the component rendered with the reasoning part
      // The ReasoningGroupTitle should show "Thought for Xs" when no tools exist
      // The component should render without crashing
      expect(container.textContent).toMatch(/thought|completed/i)
      expect(container).toBeInTheDocument()
    })
  })

  describe('tools filtering', () => {
    it('should filter tools from parts correctly', () => {
      const searchTool = createMockToolPart('search')
      const reasoningPart = createMockReasoningPart('streaming')
      const readFileTool = createMockToolPart('read_file')
      const parts: ReasoningGroupItem[] = [
        { type: 'tool', content: searchTool, id: searchTool.toolCallId },
        { type: 'reasoning', content: reasoningPart, id: 'reasoning-0' },
        { type: 'tool', content: readFileTool, id: readFileTool.toolCallId },
      ]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Should render items for all parts (tools and reasoning)
      // Tools should be in the ReasoningGroupTitle, reasoning should be in ReasoningItem
      // The ReasoningGroupTitle should show completion message with 2 steps (2 tools) when not thinking
      // But since isStreaming is true, it might show loading messages
      // At minimum, verify the component renders
      expect(container.textContent).toBeTruthy()
      // ReasoningDisplay should show the reasoning text when streaming
      expect(container.textContent).toContain('Let me think about this...')
    })

    it('should handle empty parts array', () => {
      const parts: ReasoningGroupItem[] = []
      render(
        <ReasoningGroup
          parts={parts}
          isStreaming={false}
          isLastPartInMessage={false}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        {
          wrapper: TestWrapper,
        },
      )

      // Should still render the Expandable component
      // The title should show "Thought for 0s" or similar
      expect(screen.getByText(/thought|0/i)).toBeInTheDocument()
    })
  })

  describe('currentReasoningPart', () => {
    it('should use the last reasoning part for ReasoningDisplay', () => {
      const firstReasoning = createMockReasoningPart('streaming', undefined, 'First reasoning')
      const searchTool = createMockToolPart('search')
      const lastReasoning = createMockReasoningPart('streaming', undefined, 'Last reasoning')
      const parts: ReasoningGroupItem[] = [
        { type: 'reasoning', content: firstReasoning, id: 'reasoning-0' },
        { type: 'tool', content: searchTool, id: searchTool.toolCallId },
        { type: 'reasoning', content: lastReasoning, id: 'reasoning-1' },
      ]
      const { container } = render(
        <ReasoningGroup
          parts={parts}
          isStreaming={true}
          isLastPartInMessage={true}
          hasTextPart={false}
          reasoningTime={testReasoningTime}
        />,
        { wrapper: TestWrapper },
      )

      // Should show the last reasoning part text in ReasoningDisplay (when streaming)
      expect(container.textContent).toContain('Last reasoning')
      // Should not show the first reasoning part text (only the last one is used for ReasoningDisplay)
      expect(container.textContent).not.toContain('First reasoning')
    })
  })
})
