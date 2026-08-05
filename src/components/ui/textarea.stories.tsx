/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Textarea } from './textarea'

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Multiline input using `field-sizing-content`, so it grows with its content from a 5-line (mobile) / 4-line (desktop) minimum.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
  args: {
    placeholder: 'Describe what this skill should do...',
  },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithContent: Story = {
  args: {
    defaultValue:
      'Summarize my unread emails from today. Group them by sender, highlight anything that looks urgent, and end with a one-line suggestion of what to tackle first.',
  },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'This field is locked.' },
}
