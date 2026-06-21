/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SkillForm } from '@/skills/skill-form'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'skills/skill-form',
  component: SkillForm,
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 600 },
    },
  },
  tags: ['autodocs'],
  args: { onCancel: fn(), onSubmit: fn(), onDirtyChange: fn() },
} satisfies Meta<typeof SkillForm>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {
  args: {
    mode: 'create',
  },
}

export const Edit: Story = {
  args: {
    mode: 'edit',
    initialValues: {
      name: 'meeting-notes',
      description:
        'Use this skill when the user shares raw meeting notes, a transcript, or bullets from a recent call and wants them cleaned up, summarized, or turned into action items.',
      instruction:
        "Pull three things out of the notes, in this order. Do not skip any of them.\n\n1. DECISIONS — what was actually decided.\n2. ACTION ITEMS — who does what by when.\n3. OPEN QUESTIONS — anything that came up but didn't resolve.",
      scope: 'workspace',
    },
  },
}

export const NameTaken: Story = {
  args: {
    mode: 'create',
    nameError: 'A skill named "meeting-notes" already exists.',
  },
}

export const SpecViolationFromServer: Story = {
  args: {
    mode: 'create',
    nameError: 'Name may only contain lowercase letters, numbers, and hyphens.',
  },
}
