/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ToolItem } from '@/components/chat/tool-item'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ContentViewProvider } from '@/content-view/context'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ToolUIPart } from 'ai'

const meta = {
  title: 'components/chat/tool-item',
  component: ToolItem,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A tool item component that displays individual tool calls with their metadata, state, and interaction capabilities.',
      },
    },
  },
  decorators: [
    (Story) => (
      <SidebarProvider defaultOpen={false}>
        <ContentViewProvider>
          <div className="p-8 bg-background">
            <Story />
          </div>
        </ContentViewProvider>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof ToolItem>

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

export const Loading: Story = {
  args: {
    tool: createMockTool('input-streaming', undefined, 'loading-1'),
    index: 0,
    onOpenDetails: (tool) => console.log('Open details for:', tool),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool item in loading state, showing animated spinner.',
      },
    },
  },
}

export const Completed: Story = {
  args: {
    tool: createMockTool('output-available', { results: ['Result 1', 'Result 2'] }, 'completed-1'),
    index: 0,
    onOpenDetails: (tool) => console.log('Open details for:', tool),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool item that has successfully completed and has output.',
      },
    },
  },
}

export const Error: Story = {
  args: {
    tool: createMockTool('output-error', undefined, 'error-1'),
    index: 0,
    onOpenDetails: (tool) => console.log('Open details for:', tool),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool item that encountered an error during execution.',
      },
    },
  },
}

export const WithFavicon: Story = {
  args: {
    tool: createMockTool(
      'output-available',
      [{ title: 'Example', url: 'https://example.com', favicon: 'https://www.google.com/favicon.ico' }],
      'favicon-1',
    ),
    index: 0,
    onOpenDetails: (tool) => console.log('Open details for:', tool),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool item showing a favicon from search results.',
      },
    },
  },
}

export const FetchContentTool: Story = {
  args: {
    tool: createMockTool(
      'output-available',
      { content: 'Page content...', favicon: 'https://example.com/favicon.ico' },
      'fetch-1',
      'tool:fetch_content',
    ),
    index: 0,
    onOpenDetails: (tool) => console.log('Open details for:', tool),
  },
  parameters: {
    docs: {
      description: {
        story: 'Fetch content tool with favicon.',
      },
    },
  },
}
