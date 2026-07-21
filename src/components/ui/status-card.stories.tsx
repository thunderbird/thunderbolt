/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { CheckCircle2 } from 'lucide-react'

import { StatusCard } from './status-card'

const meta = {
  title: 'UI/StatusCard',
  component: StatusCard,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: 'All systems operational',
    description: 'Last checked 2 minutes ago.',
  },
}

export const WithIconTitle: Story = {
  args: {
    title: (
      <>
        <CheckCircle2 className="size-5 text-success" />
        Connected
      </>
    ),
    description: 'Your account is synced across 3 devices.',
  },
}

export const TitleOnly: Story = {
  args: {
    title: 'No description card',
  },
}
