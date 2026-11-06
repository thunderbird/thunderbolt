/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'Skills/DiscardCreateDialog',
  component: DiscardCreateDialog,
  parameters: {
    layout: 'centered',
    docs: {
      story: { inline: false, iframeHeight: 320 },
    },
  },
  tags: ['autodocs'],
  args: { onConfirm: fn(), onOpenChange: fn() },
} satisfies Meta<typeof DiscardCreateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {
  args: {
    open: true,
  },
}

export const Edit: Story = {
  args: {
    open: true,
    title: 'Leave without saving?',
    description: "Your changes won't be saved.",
  },
}
