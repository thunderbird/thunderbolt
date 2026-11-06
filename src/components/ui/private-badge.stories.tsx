/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { PrivateBadge } from './private-badge'

const meta = {
  title: 'UI/PrivateBadge',
  component: PrivateBadge,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Confidential-model indicator: gradient lock + "Private" wordmark in one continuous amber→raspberry sweep. Used in the model selector and models settings.',
      },
    },
  },
} satisfies Meta<typeof PrivateBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const InContext: Story = {
  render: () => (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
      <span className="text-sm">Claude Sonnet</span>
      <PrivateBadge />
    </div>
  ),
}
