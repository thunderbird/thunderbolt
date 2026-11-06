/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Paperclip, Plug } from 'lucide-react'
import { useState } from 'react'

import { Button } from './button'
import { ResponsiveActionMenu } from './responsive-action-menu'

const meta = {
  title: 'UI/ResponsiveActionMenu',
  component: ResponsiveActionMenu,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'An action menu that renders a DropdownMenu on desktop and a MobileCardMenu drawer on mobile from one actions array. Used by ChatAddMenu and SuggestionChip.',
      },
    },
  },
} satisfies Meta<typeof ResponsiveActionMenu>

export default meta
type Story = StoryObj<typeof meta>

const DemoMenu = () => {
  const [open, setOpen] = useState(false)
  return (
    <ResponsiveActionMenu
      open={open}
      onOpenChange={setOpen}
      title="Add to chat"
      trigger={<Button variant="outline">Open menu</Button>}
      actions={[
        {
          label: 'Upload file',
          icon: <Paperclip className="size-[var(--icon-size-sm)] text-muted-foreground" />,
          onSelect: () => {},
        },
        {
          label: 'Connections',
          icon: <Plug className="size-[var(--icon-size-sm)] text-muted-foreground" />,
          onSelect: () => {},
        },
      ]}
    />
  )
}

export const Desktop: Story = {
  args: {
    open: false,
    onOpenChange: () => {},
    title: 'Add to chat',
    trigger: <Button variant="outline">Open menu</Button>,
    actions: [],
  },
  render: () => <DemoMenu />,
}

export const Mobile: Story = {
  args: {
    open: false,
    onOpenChange: () => {},
    title: 'Add to chat',
    trigger: <Button variant="outline">Open menu</Button>,
    actions: [],
  },
  render: () => <DemoMenu />,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
  },
  decorators: [
    (Story) => (
      <div className="p-4">
        <Story />
      </div>
    ),
  ],
}
