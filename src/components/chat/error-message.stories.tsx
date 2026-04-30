/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxRetries } from '@/chats/chat-instance'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ErrorMessage } from './error-message'

const meta = {
  title: 'Chat/ErrorMessage',
  component: ErrorMessage,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Two-phase error banner shown during chat failures. Displays a yellow "retrying" state with a spinner during auto-retries, then a red error state with a manual Retry button when all attempts are exhausted.',
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

export const Retrying: Story = {
  args: {
    retryCount: 1,
    retriesExhausted: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'Yellow banner with spinner shown while auto-retries are in progress.',
      },
    },
  },
}

export const RetryingSecondAttempt: Story = {
  args: {
    retryCount: 2,
    retriesExhausted: false,
  },
}

export const RetryingFinalAttempt: Story = {
  args: {
    retryCount: maxRetries,
    retriesExhausted: false,
  },
}

export const RetriesExhausted: Story = {
  args: {
    retryCount: maxRetries,
    retriesExhausted: true,
    onRetry: () => {
      console.log('Retry clicked')
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Red banner with manual Retry button shown after all auto-retries have failed.',
      },
    },
  },
}

export const RetriesExhaustedNoRetryHandler: Story = {
  args: {
    retryCount: maxRetries,
    retriesExhausted: true,
  },
  parameters: {
    docs: {
      description: {
        story: 'Red banner without Retry button when no onRetry handler is provided.',
      },
    },
  },
}
