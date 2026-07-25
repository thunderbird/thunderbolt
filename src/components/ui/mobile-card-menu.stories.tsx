/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Paperclip, Plug } from 'lucide-react'
import { fn } from 'storybook/test'

import { MobileCardMenu } from './mobile-card-menu'

const meta = {
  title: 'UI/MobileCardMenu',
  component: MobileCardMenu,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
    docs: {
      description: {
        component:
          'Floating mobile menu card built on the Drawer primitive, with safe-area placement and directional entry. Used by ChatAddMenu and SearchableMenu on mobile.',
      },
    },
  },
  args: {
    open: true,
    onOpenChange: fn(),
    title: 'Add to chat',
    children: null,
  },
} satisfies Meta<typeof MobileCardMenu>

export default meta
type Story = StoryObj<typeof meta>

const menuItems = (
  <div className="flex flex-col gap-0.5 px-1 pb-1">
    <button
      type="button"
      className="flex min-h-[var(--min-touch-height)] w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[length:var(--font-size-body)] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
    >
      <Paperclip className="size-[var(--icon-size-sm)] text-muted-foreground" />
      Upload file
    </button>
    <button
      type="button"
      className="flex min-h-[var(--min-touch-height)] w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[length:var(--font-size-body)] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
    >
      <Plug className="size-[var(--icon-size-sm)] text-muted-foreground" />
      Connections
    </button>
  </div>
)

export const Bottom: Story = {
  render: (args) => <MobileCardMenu {...args}>{menuItems}</MobileCardMenu>,
}

export const Top: Story = {
  render: (args) => (
    <MobileCardMenu {...args} side="top" title="Switch mode">
      {menuItems}
    </MobileCardMenu>
  ),
}
