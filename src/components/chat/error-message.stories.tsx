import type { Meta, StoryObj } from '@storybook/react-vite'
import { ErrorMessage } from './error-message'

const meta = {
  title: 'Chat/ErrorMessage',
  component: ErrorMessage,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Error banner displayed when a chat message fails.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorMessage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    message: 'Failed to connect to the server. Please check your connection and try again.',
  },
}

export const NullMessage: Story = {
  args: {
    message: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When message is null, a default error message is displayed.',
      },
    },
  },
}

export const LongMessage: Story = {
  args: {
    message:
      'The request timed out after waiting for a response from the server. This could be due to network issues, server overload, or the request being too complex. Please try again with a simpler request or check your network connection.',
  },
}
