import { CopyMessageButton } from '@/components/chat/copy-message-button'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/copy-message-button',
  component: CopyMessageButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    text: {
      control: 'text',
      description: 'The text to copy to clipboard when clicked',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
  args: {
    text: 'Hello, this is a sample message to copy!',
  },
} satisfies Meta<typeof CopyMessageButton>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Default copy button with sample text
 */
export const Default: Story = {}

/**
 * Copy button with a long markdown message
 */
export const LongMarkdown: Story = {
  args: {
    text: '## Summary\n\nHere are two standout thriller films:\n\n1. **Black Bag** – A sleek spy-thriller\n2. **Highest 2 Lowest** – A tense kidnapping drama',
  },
}

/**
 * Copy button with custom className
 */
export const CustomClass: Story = {
  args: {
    text: 'Custom styled button',
    className: 'bg-muted rounded-full',
  },
}
