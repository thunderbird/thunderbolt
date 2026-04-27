/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ToolIcon } from '@/components/chat/tool-icon'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Globe, Mail, Search } from 'lucide-react'

const meta = {
  title: 'components/chat/tool-icon',
  component: ToolIcon,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A component that displays tool icons with loading states, favicons for web content, and error states. Automatically handles favicon fetching and proxying for search and fetch_content tools.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="p-8 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  args: {
    toolName: 'search',
    toolOutput: null,
    Icon: Search,
    initials: 'SE',
    isLoading: true,
    isError: false,
    tooltipKey: 'loading-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool in loading state, showing animated spinner.',
      },
    },
  },
}

export const WithIcon: Story = {
  args: {
    toolName: 'get_current_weather',
    toolOutput: { temperature: 72, condition: 'sunny' },
    Icon: Globe,
    initials: 'WE',
    isLoading: false,
    isError: false,
    tooltipKey: 'icon-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool with a standard Lucide icon.',
      },
    },
  },
}

export const WithFavicon: Story = {
  args: {
    toolName: 'fetch_content',
    toolOutput: {
      content: 'Example content...',
      favicon: 'https://www.google.com/favicon.ico',
    },
    Icon: Globe,
    initials: 'FC',
    isLoading: false,
    isError: false,
    tooltipKey: 'favicon-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool with favicon extracted from fetch_content output. The favicon is proxied through the backend.',
      },
    },
  },
}

export const SearchWithFavicon: Story = {
  args: {
    toolName: 'search',
    toolOutput: [
      {
        title: 'Example Result',
        url: 'https://example.com',
        favicon: 'https://example.com/favicon.ico',
      },
    ],
    Icon: Search,
    initials: 'SE',
    isLoading: false,
    isError: false,
    tooltipKey: 'search-favicon-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Search tool with favicon from the first result in the array.',
      },
    },
  },
}

export const ErrorState: Story = {
  args: {
    toolName: 'google_get_email',
    toolOutput: null,
    Icon: Mail,
    initials: 'EM',
    isLoading: false,
    isError: true,
    tooltipKey: 'error-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool in error state, showing the icon with yellow/error styling.',
      },
    },
  },
}

export const WithInitials: Story = {
  args: {
    toolName: 'custom_tool',
    toolOutput: { result: 'success' },
    Icon: null,
    initials: 'CT',
    isLoading: false,
    isError: false,
    tooltipKey: 'initials-example',
    onClick: () => console.log('Clicked!'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Tool without an icon, falling back to initials display.',
      },
    },
  },
}

export const AllStates = {
  render: () => (
    <div className="flex gap-4 items-center flex-wrap">
      <div className="flex flex-col items-center gap-2">
        <ToolIcon
          toolName="search"
          toolOutput={null}
          Icon={Search}
          initials="SE"
          isLoading={true}
          isError={false}
          tooltipKey="all-loading"
          onClick={() => {}}
        />
        <span className="text-xs text-muted-foreground">Loading</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <ToolIcon
          toolName="get_weather"
          toolOutput={{ temp: 72 }}
          Icon={Globe}
          initials="WE"
          isLoading={false}
          isError={false}
          tooltipKey="all-icon"
          onClick={() => {}}
        />
        <span className="text-xs text-muted-foreground">Icon</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <ToolIcon
          toolName="fetch_content"
          toolOutput={{ favicon: 'https://www.google.com/favicon.ico' }}
          Icon={Globe}
          initials="FC"
          isLoading={false}
          isError={false}
          tooltipKey="all-favicon"
          onClick={() => {}}
        />
        <span className="text-xs text-muted-foreground">Favicon</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <ToolIcon
          toolName="error_tool"
          toolOutput={null}
          Icon={Mail}
          initials="ER"
          isLoading={false}
          isError={true}
          tooltipKey="all-error"
          onClick={() => {}}
        />
        <span className="text-xs text-muted-foreground">Error</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <ToolIcon
          toolName="custom"
          toolOutput={{ result: 'ok' }}
          Icon={null}
          initials="CT"
          isLoading={false}
          isError={false}
          tooltipKey="all-initials"
          onClick={() => {}}
        />
        <span className="text-xs text-muted-foreground">Initials</span>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'All possible states of the ToolIcon component displayed together for comparison.',
      },
    },
  },
}
