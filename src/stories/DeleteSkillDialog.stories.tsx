/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DeleteSkillDialog } from '@/skills/delete-skill-dialog'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'Skills/DeleteSkillDialog',
  component: DeleteSkillDialog,
  parameters: {
    layout: 'centered',
    docs: {
      story: { inline: false, iframeHeight: 320 },
    },
  },
  tags: ['autodocs'],
  args: { onConfirm: fn(), onOpenChange: fn() },
} satisfies Meta<typeof DeleteSkillDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  args: {
    open: true,
    skillName: 'meeting-notes',
  },
}

export const LongName: Story = {
  args: {
    open: true,
    skillName: 'really-long-skill-name-with-many-hyphens-spanning-the-row',
  },
}

export const Closed: Story = {
  args: {
    open: false,
    skillName: 'meeting-notes',
  },
}
