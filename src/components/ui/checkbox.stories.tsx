/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Checkbox } from './checkbox'

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Unchecked: Story = {}

export const Checked: Story = {
  args: { defaultChecked: true },
}

export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Checkbox disabled />
      <Checkbox disabled defaultChecked />
    </div>
  ),
}

export const WithLabel: Story = {
  // Matches the app's checkbox rows (privacy step, recovery-key step): a
  // plain label in regular weight — not the form-field Label primitive.
  render: () => (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
      <Checkbox id="terms" />
      <span>Accept terms and conditions</span>
    </label>
  ),
}
