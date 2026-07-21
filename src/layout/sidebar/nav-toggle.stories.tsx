/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { BrowserRouter } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import type { SidebarSection } from './types'

const meta = {
  title: 'Sidebar/SidebarNavToggle',
  component: SidebarNavToggle,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Segmented pill toggle that switches the sidebar between Chats and Settings. The selected thumb slides between segments.',
      },
    },
  },
  decorators: [
    (Story) => (
      <BrowserRouter>
        <SidebarProvider>
          <TooltipProvider>
            <div className="w-64 border rounded-lg p-2 bg-sidebar">
              <Story />
            </div>
          </TooltipProvider>
        </SidebarProvider>
      </BrowserRouter>
    ),
  ],
} satisfies Meta<typeof SidebarNavToggle>

export default meta
type Story = StoryObj<typeof meta>

const InteractiveToggle = () => {
  const [active, setActive] = useState<SidebarSection>('chats')
  return <SidebarNavToggle activeSection={active} onSectionChange={setActive} />
}

export const Interactive: Story = {
  args: {
    activeSection: 'chats',
    onSectionChange: () => {},
  },
  render: () => <InteractiveToggle />,
  parameters: {
    docs: {
      description: {
        story: 'Fully interactive toggle — click segments to see the thumb slide.',
      },
    },
  },
}

export const SettingsActive: Story = {
  args: {
    activeSection: 'settings',
    onSectionChange: () => {},
  },
  parameters: {
    docs: {
      description: {
        story: 'Static view with the Settings section selected.',
      },
    },
  },
}
