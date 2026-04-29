/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { MobileUserMessage } from './mobile-user-message'

const meta = {
  title: 'Chat/MobileUserMessage',
  component: MobileUserMessage,
  parameters: {
    layout: 'padded',
    viewport: { defaultViewport: 'mobile1' },
    docs: {
      description: {
        component:
          'Mobile user message with long-press context menu for copy. Long press the message bubble to trigger the blur overlay and copy action.',
      },
    },
  },
} satisfies Meta<typeof MobileUserMessage>

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
