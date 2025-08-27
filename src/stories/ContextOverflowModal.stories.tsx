import { ContextOverflowModal } from '@/components/context-overflow-modal'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/context-overflow-modal',
  component: ContextOverflowModal,
  parameters: {
    layout: 'centered',
    docs: {
      story: {
        inline: false,
        iframeHeight: 400,
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    isOpen: {
      control: { type: 'boolean' },
      description: 'Whether the modal is open',
    },
    maxTokens: {
      control: { type: 'number', min: 1000, max: 300000 },
      description: 'Maximum number of tokens for the model',
    },
  },
  args: {
    onClose: fn(),
    onNewChat: fn(),
  },
} satisfies Meta<typeof ContextOverflowModal>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    isOpen: true,
    maxTokens: 256000,
  },
}

export const UnknownMaxTokens: Story = {
  args: {
    isOpen: true,
    maxTokens: undefined,
  },
}

export const SmallModel: Story = {
  args: {
    isOpen: true,
    maxTokens: 4096,
  },
}

export const Closed: Story = {
  args: {
    isOpen: false,
    maxTokens: 256000,
  },
}
