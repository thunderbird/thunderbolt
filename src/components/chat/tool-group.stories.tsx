import { ToolGroup } from '@/components/chat/tool-group'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ContentViewProvider } from '@/content-view/context'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ToolUIPart } from 'ai'

const meta = {
  title: 'components/chat/tool-group',
  component: ToolGroup,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A tool group component that displays multiple tool calls together with optional loading indicator for the next action.',
      },
    },
  },
  decorators: [
    (Story) => (
      <SidebarProvider defaultOpen={false}>
        <ContentViewProvider>
          <div className="p-8 bg-background max-w-2xl">
            <Story />
          </div>
        </ContentViewProvider>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof ToolGroup>

export default meta
type Story = StoryObj<typeof meta>

const createMockTool = (
  state: ToolUIPart['state'],
  output?: unknown,
  toolCallId?: string,
  type = 'tool:search',
): ToolUIPart =>
  ({
    type,
    state,
    output,
    toolCallId,
    input: {},
  }) as ToolUIPart

export const SingleToolLoading: Story = {
  args: {
    tools: [createMockTool('input-streaming', undefined, 'tool-1')],
    isStreaming: true,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'A single tool still executing. No "next action" loading indicator shown.',
      },
    },
  },
}

export const SingleToolComplete: Story = {
  args: {
    tools: [createMockTool('output-available', { result: 'success' }, 'tool-1')],
    isStreaming: false,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'A single completed tool. Not streaming, so no loading indicator.',
      },
    },
  },
}

export const MultipleToolsLoading: Story = {
  args: {
    tools: [
      createMockTool('output-available', { result: 'success' }, 'tool-1', 'tool:search'),
      createMockTool('input-streaming', undefined, 'tool-2', 'tool:fetch_content'),
      createMockTool('input-available', undefined, 'tool-3', 'tool:get_weather'),
    ],
    isStreaming: true,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'Multiple tools, some still executing. No "next action" indicator because tools are still in progress.',
      },
    },
  },
}

export const MultipleToolsCompleteWithNextAction: Story = {
  args: {
    tools: [
      createMockTool('output-available', { result: 'success' }, 'tool-1', 'tool:search'),
      createMockTool('output-available', { result: 'data' }, 'tool-2', 'tool:fetch_content'),
      createMockTool('output-available', { result: 'info' }, 'tool-3', 'tool:get_weather'),
    ],
    isStreaming: true,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          'All tools complete, still streaming, and no text yet. Shows the "Thinking..." loading indicator for the next action.',
      },
    },
  },
}

export const MultipleToolsWithText: Story = {
  args: {
    tools: [
      createMockTool('output-available', { result: 'success' }, 'tool-1', 'tool:search'),
      createMockTool('output-available', { result: 'data' }, 'tool-2', 'tool:fetch_content'),
    ],
    isStreaming: true,
    isLastPartInMessage: false,
    hasTextInMessage: true,
  },
  parameters: {
    docs: {
      description: {
        story: 'Tools complete with text already in the message. No loading indicator because text phase has started.',
      },
    },
  },
}

export const ToolsWithError: Story = {
  args: {
    tools: [
      createMockTool('output-available', { result: 'success' }, 'tool-1', 'tool:search'),
      createMockTool('output-error', undefined, 'tool-2', 'tool:fetch_content'),
      createMockTool('output-available', { result: 'info' }, 'tool-3', 'tool:get_weather'),
    ],
    isStreaming: true,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Tools complete with one error. Still shows "Thinking..." indicator because errored tools are considered complete.',
      },
    },
  },
}

export const ManyTools: Story = {
  args: {
    tools: [
      createMockTool('output-available', { result: '1' }, 'tool-1', 'tool:search'),
      createMockTool('output-available', { result: '2' }, 'tool-2', 'tool:fetch_content'),
      createMockTool('output-available', { result: '3' }, 'tool-3', 'tool:get_weather'),
      createMockTool('output-available', { result: '4' }, 'tool-4', 'tool:search'),
      createMockTool('output-available', { result: '5' }, 'tool-5', 'tool:get_email'),
      createMockTool('output-available', { result: '6' }, 'tool-6', 'tool:search'),
    ],
    isStreaming: false,
    isLastPartInMessage: true,
    hasTextInMessage: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'Many tools showing the wrap behavior of the tool group layout.',
      },
    },
  },
}
