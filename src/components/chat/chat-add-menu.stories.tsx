/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

import { ChatAddMenu } from './chat-add-menu'

const meta = {
  title: 'Chat/ChatAddMenu',
  component: ChatAddMenu,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The composer\'s "+" menu for attaching files and opening connections. Renders a dropdown on desktop and a MobileCardMenu drawer on mobile.',
      },
    },
  },
  args: {
    onUploadFile: fn(),
    onOpenConnections: fn(),
  },
} satisfies Meta<typeof ChatAddMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {}

export const Mobile: Story = {
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
  },
  decorators: [
    (Story) => (
      <div className="p-4">
        <Story />
      </div>
    ),
  ],
}
