import { ContextUsageIndicator } from '@/components/context-usage-indicator'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/context-usage-indicator',
  component: ContextUsageIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    usedTokens: {
      control: { type: 'number', min: 0, max: 300000 },
      description: 'Number of tokens currently used',
    },
    maxTokens: {
      control: { type: 'number', min: 1000, max: 300000 },
      description: 'Maximum number of tokens available',
    },
    isKnown: {
      control: { type: 'boolean' },
      description: 'Whether the context window is known',
    },
  },
} satisfies Meta<typeof ContextUsageIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const SmallUsage: Story = {
  args: {
    usedTokens: 42,
    maxTokens: 4096,
    isKnown: true,
  },
  name: '1% Usage',
}

export const Normal: Story = {
  args: {
    usedTokens: 128000,
    maxTokens: 256000,
    isKnown: true,
  },
  name: '50% Usage',
}

export const NearLimit: Story = {
  args: {
    usedTokens: 220000,
    maxTokens: 256000,
    isKnown: true,
  },
  name: '86% Usage',
}

export const OverLimit: Story = {
  args: {
    usedTokens: 281600,
    maxTokens: 256000,
    isKnown: true,
  },
  name: '110% Usage (Over Limit)',
}

export const Hidden: Story = {
  args: {
    usedTokens: 5000,
    maxTokens: undefined,
    isKnown: false,
  },
  name: 'Hidden (No Context Data)',
  render: () => (
    <div className="p-4 border-2 border-dashed border-gray-300 text-center text-sm text-gray-500">
      Component is hidden when context data is unavailable
    </div>
  ),
}
