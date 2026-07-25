/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

import { PageCreateAction } from './page-create-action'

const meta = {
  title: 'UI/PageCreateAction',
  component: PageCreateAction,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A list page\'s primary create action: a compact outline "+" beside the page title on desktop, a floating brand-gradient pill in the bottom-right corner on mobile. Resize the viewport to see both renderings.',
      },
    },
  },
  args: {
    label: 'New skill',
    onClick: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen items-start justify-end p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PageCreateAction>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {}

export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

export const Disabled: Story = {
  args: {
    disabled: true,
  },
}
