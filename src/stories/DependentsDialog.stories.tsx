/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DependentsDialog } from '@/skills/dependents-dialog'
import type { Skill } from '@/types'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const dep = (id: string, name: string): Skill => ({
  id,
  name,
  description: 'desc',
  instruction: 'inst',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
})

const meta = {
  title: 'skills/dependents-dialog',
  component: DependentsDialog,
  parameters: {
    layout: 'centered',
    docs: {
      story: { inline: false, iframeHeight: 420 },
    },
  },
  tags: ['autodocs'],
  args: { onConfirm: fn(), onOpenChange: fn(), onJumpToDependent: fn() },
} satisfies Meta<typeof DependentsDialog>

export default meta
type Story = StoryObj<typeof meta>

export const DisableSingleDependent: Story = {
  args: {
    open: true,
    action: 'disable',
    targetName: 'meeting-notes',
    dependents: [dep('1', 'weekly-review')],
  },
}

export const DeleteMultipleDependents: Story = {
  args: {
    open: true,
    action: 'delete',
    targetName: 'task-triage',
    dependents: [dep('1', 'weekly-review'), dep('2', 'planning-session'), dep('3', 'standup-prep')],
  },
}
