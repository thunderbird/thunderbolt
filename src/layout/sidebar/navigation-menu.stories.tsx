/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { BrowserRouter } from 'react-router'
import { NavigationMenu } from './navigation-menu'

const meta = {
  title: 'layout/sidebar/NavigationMenu',
  component: NavigationMenu,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Navigation menu items for Tasks, Automations, and Settings.',
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
} satisfies Meta<typeof NavigationMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {
  args: {
    isMobile: false,
    currentPath: '/chats/123',
    showTasks: true,
    onCreateNewChat: () => console.log('New chat clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Desktop navigation menu with all items including Tasks feature.',
      },
    },
  },
}

export const DesktopWithoutTasks: Story = {
  args: {
    isMobile: false,
    currentPath: '/chats/123',
    showTasks: false,
    onCreateNewChat: () => console.log('New chat clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Desktop navigation menu without experimental Tasks feature.',
      },
    },
  },
}

export const Mobile: Story = {
  args: {
    isMobile: true,
    currentPath: '/chats/123',
    showTasks: true,
    onCreateNewChat: () => console.log('New chat clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Mobile navigation menu - Settings uses onClick instead of NavLink.',
      },
    },
  },
}

export const OnAutomationsPage: Story = {
  args: {
    isMobile: false,
    currentPath: '/automations',
    showTasks: true,
    onCreateNewChat: () => console.log('New chat clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Navigation menu when on the Automations page (active state).',
      },
    },
  },
}

export const OnSettingsPage: Story = {
  args: {
    isMobile: false,
    currentPath: '/settings/preferences',
    showTasks: true,
    onCreateNewChat: () => console.log('New chat clicked'),
    onSettingsClick: () => console.log('Settings clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Navigation menu when on a Settings page (active state).',
      },
    },
  },
}
