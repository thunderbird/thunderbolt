/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { AppLogo } from './app-logo'

const meta = {
  title: 'Components/AppLogo',
  component: AppLogo,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof AppLogo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <AppLogo size={16} />
      <AppLogo size={24} />
      <AppLogo size={48} />
      <AppLogo size={96} />
    </div>
  ),
}
