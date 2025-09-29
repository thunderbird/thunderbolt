import { ToolGroup } from '@/components/chat/tool-group'
import { ObjectViewProvider } from '@/components/chat/object-view-provider'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ToolUIPart } from 'ai'
import { SidebarProvider } from '@/components/ui/sidebar'

// Mock tool data for different states
const mockTools: ToolUIPart[] = [
  {
    type: 'tool-search',
    toolCallId: 'call-1',
    input: { query: 'latest AI developments' },
    state: 'output-available',
    output: { results: [{ title: 'AI News', content: 'Latest developments...' }] },
  },
  {
    type: 'tool-google_get_drive_file_content',
    toolCallId: 'call-2',
    input: { fileId: '1ABC123' },
    state: 'input-streaming',
  },
  {
    type: 'tool-get_current_weather',
    toolCallId: 'call-3',
    input: { location: 'New York' },
    state: 'output-available',
    output: { temperature: 72, condition: 'sunny' },
  },
]

const singleTool: ToolUIPart[] = [
  {
    type: 'tool-fetch_content',
    toolCallId: 'call-1',
    input: { url: 'https://example.com' },
    state: 'output-available',
    output: { content: 'Web page content...' },
  },
]

// Wrapper component to provide context
const ToolGroupWrapper = ({ tools }: { tools: ToolUIPart[] }) => (
  <SidebarProvider defaultOpen={false}>
    <ObjectViewProvider>
      <div className="p-4 bg-background">
        <ToolGroup tools={tools} />
      </div>
    </ObjectViewProvider>
  </SidebarProvider>
)

const meta = {
  title: 'components/chat/tool-group',
  component: ToolGroupWrapper,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A component that displays a group of tool avatars with loading states and tooltips. Each tool shows its icon, loading state, and can be clicked to open details in a sidebar.',
      },
    },
  },
  argTypes: {
    tools: {
      control: false,
      description: 'Array of ToolUIPart objects representing the tools to display',
    },
  },
} satisfies Meta<typeof ToolGroupWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const SingleTool: Story = {
  args: {
    tools: singleTool,
  },
  parameters: {
    docs: {
      description: {
        story: 'A single tool in completed state, demonstrating the component with minimal content.',
      },
    },
  },
}

export const ManyTools: Story = {
  args: {
    tools: [
      ...mockTools,
      {
        type: 'tool-google_search_emails',
        toolCallId: 'call-4',
        input: { query: 'important meeting' },
        state: 'output-available',
        output: { emails: [{ subject: 'Meeting Notes', from: 'colleague@company.com' }] },
      },
      {
        type: 'tool-google_check_calendar',
        toolCallId: 'call-5',
        input: { maxResults: 5 },
        state: 'input-streaming',
      },
      {
        type: 'tool-google_get_email',
        toolCallId: 'call-6',
        input: { messageId: 'msg-123' },
        state: 'output-available',
        output: { subject: 'Test Email', body: 'Email content...' },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: 'Multiple tools showing how the component handles a larger number of tools with wrapping layout.',
      },
    },
  },
}
