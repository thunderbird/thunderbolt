import type { Meta, StoryObj } from '@storybook/react-vite'
import { CopyMessageButton } from './copy-message-button'

const meta = {
  title: 'Chat/CopyMessageButton',
  component: CopyMessageButton,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component: 'A button that copies text to clipboard with a checkmark feedback animation.',
      },
    },
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

export const Default: Story = {}

export const LongMarkdown: Story = {
  args: {
    text: '## Summary\n\nHere are two standout thriller films:\n\n1. **Black Bag** – A sleek spy-thriller\n2. **Highest 2 Lowest** – A tense kidnapping drama',
  },
}

export const CustomClass: Story = {
  args: {
    text: 'Custom styled button',
    className: 'bg-muted rounded-full',
  },
}
