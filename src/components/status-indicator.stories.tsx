/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { StatusIndicator, statusStates } from './status-indicator'

const meta = {
  title: 'Components/StatusIndicator',
  component: StatusIndicator,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component: 'Status dot used to visualise connectivity state (MCP servers, devices, sync).',
      },
    },
  },
} satisfies Meta<typeof StatusIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { status: 'online' },
}

export const AllStates: Story = {
  args: { status: 'online' },
  render: () => (
    <div className="flex flex-col gap-2">
      {statusStates.map((status) => (
        <div key={status} className="flex items-center gap-2">
          <StatusIndicator status={status} />
          <span className="text-sm">{status}</span>
        </div>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  args: { status: 'online' },
  render: () => (
    <div className="flex items-center gap-3">
      <StatusIndicator status="online" size="sm" />
      <StatusIndicator status="online" size="md" />
      <StatusIndicator status="online" size="lg" />
    </div>
  ),
}
