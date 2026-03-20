import type { Meta, StoryObj } from '@storybook/react-vite'
import { DesktopUserMessage } from './desktop-user-message'

const meta = {
  title: 'Chat/DesktopUserMessage',
  component: DesktopUserMessage,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Desktop user message with copy button visible on hover.',
      },
    },
  },
} satisfies Meta<typeof DesktopUserMessage>

export default meta
type Story = StoryObj<typeof meta>

export const Short: Story = {
  args: {
    message: {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'What is the square root of 144?' }],
    },
  },
}

export const Long: Story = {
  args: {
    message: {
      id: 'msg-2',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'Come up with a news aggregator website where readers can find and rate articles, authors and outlets. They can see ratings and evaluate quality of news.',
        },
      ],
    },
  },
}
