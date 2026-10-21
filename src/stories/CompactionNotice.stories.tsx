/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CompactionNotice } from '@/components/context-usage'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'Components/CompactionNotice',
  component: CompactionNotice,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof CompactionNotice>

export default meta
type Story = StoryObj<typeof meta>

export const Compacting: Story = { args: { status: 'compacting' } }
export const Compacted: Story = { args: { status: 'compacted' } }
export const Idle: Story = { args: { status: 'idle' } }
