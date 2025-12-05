import type { Meta, StoryObj } from '@storybook/react-vite'
import { Lock, Star, Zap } from 'lucide-react'
import { useState } from 'react'
import { SearchableMenu } from './searchable-menu'
import type { SearchableMenuGroup, SearchableMenuItem } from './types'

const meta = {
  title: 'components/ui/SearchableMenu',
  component: SearchableMenu,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'A searchable dropdown menu component that supports flat and grouped items, custom rendering, and mobile-optimized behavior with blur backdrop.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="p-8 min-h-[400px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchableMenu>

export default meta
type Story = StoryObj<typeof meta>

const flatItems: SearchableMenuItem[] = [
  { id: '1', label: 'Option 1', description: 'First option description' },
  { id: '2', label: 'Option 2', description: 'Second option description' },
  { id: '3', label: 'Option 3', description: 'Third option description' },
  { id: '4', label: 'Disabled Option', description: 'This option is disabled', disabled: true },
]

const itemsWithIcons: SearchableMenuItem[] = [
  { id: 'fast', label: 'Fast Model', description: 'Quick responses', icon: <Zap className="size-4 text-yellow-500" /> },
  {
    id: 'secure',
    label: 'Secure Model',
    description: 'End-to-end encrypted',
    icon: <Lock className="size-4 text-green-500" />,
  },
  {
    id: 'premium',
    label: 'Premium Model',
    description: 'Best quality',
    icon: <Star className="size-4 text-purple-500" />,
  },
]

const groupedItems: SearchableMenuGroup[] = [
  {
    id: 'provided',
    label: 'Provided Models',
    items: [
      { id: 'gpt-oss', label: 'GPT-OSS 120B', description: 'Fast and confidential' },
      { id: 'qwen3', label: 'Qwen3 Instruct', description: 'Balance between privacy and power' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom Models',
    items: [
      { id: 'custom-1', label: 'My Custom Model', description: 'user-defined' },
      { id: 'custom-2', label: 'Another Model', description: 'user-defined' },
    ],
  },
]

export const Default: Story = {
  args: {
    items: flatItems,
    value: '1',
    onValueChange: (id) => console.log('Selected:', id),
  },
  parameters: {
    docs: {
      description: {
        story: 'Default searchable menu with flat items and search functionality.',
      },
    },
  },
}

export const WithIcons: Story = {
  args: {
    items: itemsWithIcons,
    value: 'fast',
    onValueChange: (id) => console.log('Selected:', id),
  },
  parameters: {
    docs: {
      description: {
        story: 'Menu items with icons for visual distinction.',
      },
    },
  },
}

export const GroupedItems: Story = {
  args: {
    items: groupedItems,
    value: 'gpt-oss',
    onValueChange: (id) => console.log('Selected:', id),
  },
  parameters: {
    docs: {
      description: {
        story: 'Items organized into labeled groups.',
      },
    },
  },
}

export const WithoutSearch: Story = {
  args: {
    items: flatItems,
    value: '1',
    searchable: false,
    onValueChange: (id) => console.log('Selected:', id),
  },
  parameters: {
    docs: {
      description: {
        story: 'Menu without search input, useful for small lists.',
      },
    },
  },
}

export const WithFooter: Story = {
  args: {
    items: flatItems,
    value: '1',
    onValueChange: (id) => console.log('Selected:', id),
    footer: (
      <button type="button" className="w-full text-sm text-primary hover:underline">
        + Add new item
      </button>
    ),
  },
  parameters: {
    docs: {
      description: {
        story: 'Menu with a footer action, commonly used for "Add new" functionality.',
      },
    },
  },
}

export const CustomWidth: Story = {
  args: {
    items: flatItems,
    value: '1',
    width: 400,
    onValueChange: (id) => console.log('Selected:', id),
  },
  parameters: {
    docs: {
      description: {
        story: 'Menu with custom width.',
      },
    },
  },
}

export const EmptyState: Story = {
  args: {
    items: [],
    onValueChange: (id) => console.log('Selected:', id),
    emptyMessage: 'No models available',
  },
  parameters: {
    docs: {
      description: {
        story: 'Empty state when no items are available.',
      },
    },
  },
}

const InteractiveTemplate = () => {
  const [value, setValue] = useState('1')
  return (
    <SearchableMenu
      items={flatItems}
      value={value}
      onValueChange={(id) => setValue(id)}
      searchPlaceholder="Search options..."
    />
  )
}

export const Interactive: Story = {
  render: () => <InteractiveTemplate />,
  parameters: {
    docs: {
      description: {
        story: 'Fully interactive example with controlled state.',
      },
    },
  },
}

const InteractiveGroupedTemplate = () => {
  const [value, setValue] = useState('gpt-oss')
  return (
    <SearchableMenu
      items={groupedItems}
      value={value}
      onValueChange={(id) => setValue(id)}
      searchPlaceholder="Search models..."
      footer={
        <button type="button" className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors">
          Manage models →
        </button>
      }
    />
  )
}

export const InteractiveGrouped: Story = {
  render: () => <InteractiveGroupedTemplate />,
  parameters: {
    docs: {
      description: {
        story: 'Interactive grouped menu mimicking the model selector use case.',
      },
    },
  },
}
