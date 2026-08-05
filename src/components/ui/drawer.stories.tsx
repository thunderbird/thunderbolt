/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from './drawer'

const meta = {
  title: 'UI/Drawer',
  component: Drawer,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
    docs: {
      description: {
        component:
          'Base UI drawer primitive used for mobile bottom/top sheets. Higher-level surfaces like MobileCardMenu compose it.',
      },
    },
  },
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof Drawer>

export default meta
type Story = StoryObj<typeof meta>

export const Bottom: Story = {
  render: (args) => (
    <Drawer {...args} swipeDirection="down">
      <DrawerContent>
        <DrawerHandle className="mb-1 mt-2" />
        <div className="flex flex-col gap-1 px-4 pb-6 pt-2">
          <DrawerTitle>Bottom drawer</DrawerTitle>
          <DrawerDescription>Slides up from the bottom edge with a drag handle.</DrawerDescription>
        </div>
      </DrawerContent>
    </Drawer>
  ),
}

export const Top: Story = {
  render: (args) => (
    <Drawer {...args} swipeDirection="up">
      <DrawerContent>
        <div className="flex flex-col gap-1 px-4 pb-2 pt-6">
          <DrawerTitle>Top drawer</DrawerTitle>
          <DrawerDescription>Slides down from the top edge.</DrawerDescription>
        </div>
        <DrawerHandle className="mb-2 mt-1" />
      </DrawerContent>
    </Drawer>
  ),
}
