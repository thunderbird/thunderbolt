/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NavLink } from '@/components/ui/nav-link'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { CheckSquare, MessageCirclePlus, Settings, Zap } from 'lucide-react'

type NavigationMenuProps = {
  isMobile: boolean
  currentPath: string
  showTasks: boolean
  onCreateNewChat: () => void
  onSettingsClick: () => void
}

export const NavigationMenu = ({
  isMobile,
  currentPath,
  showTasks,
  onCreateNewChat,
  onSettingsClick,
}: NavigationMenuProps) => {
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onCreateNewChat}
          tooltip="New Chat"
          className="cursor-pointer"
          isActive={currentPath === '/chats/new'}
        >
          <MessageCirclePlus className="size-[var(--icon-size-default)]" />
          <span>New Chat</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {showTasks && (
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Tasks" isActive={currentPath.startsWith('/tasks')}>
            <NavLink to="/tasks">
              <CheckSquare className="size-[var(--icon-size-default)]" />
              <span>Tasks</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Automations" isActive={currentPath.startsWith('/automations')}>
          <NavLink to="/automations">
            <Zap className="size-[var(--icon-size-default)]" />
            <span>Automations</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        {isMobile ? (
          <SidebarMenuButton
            onClick={onSettingsClick}
            isActive={currentPath.startsWith('/settings')}
            className="cursor-pointer"
          >
            <Settings className="size-[var(--icon-size-default)]" />
            <span>Settings</span>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton asChild tooltip="Settings" isActive={currentPath.startsWith('/settings')}>
            <NavLink to="/settings/preferences">
              <Settings className="size-[var(--icon-size-default)]" />
              <span>Settings</span>
            </NavLink>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    </>
  )
}
