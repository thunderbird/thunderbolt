/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarProvider } from '@/components/ui/sidebar'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SidebarHeader } from './sidebar-header'

const meta = {
  title: 'layout/sidebar/SidebarHeader',
  component: SidebarHeader,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Header component with a toggle button for expanding/collapsing the sidebar.',
      },
    },
  },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <div className="w-64 border rounded-lg p-2 bg-sidebar">
          <Story />
        </div>
      </SidebarProvider>
    ),
  ],
  args: {
    onToggle: () => console.log('Toggle clicked'),
  },
} satisfies Meta<typeof SidebarHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Default sidebar header with toggle button.',
      },
    },
  },
}
