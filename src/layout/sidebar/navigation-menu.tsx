/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NavLink } from '@/components/ui/nav-link'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { stripWorkspacePrefix, useWorkspaceUrl } from '@/lib/active-workspace'
import { CheckSquare, MessageCirclePlus, Settings } from 'lucide-react'

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
  // `isActive` highlighting reads the sub-path so the same matching rules work
  // for both personal (`/tasks`) and shared (`/w/<id>/tasks`) URLs.
  const subPath = stripWorkspacePrefix(currentPath)
  const tasksUrl = useWorkspaceUrl('/tasks')
  const settingsUrl = useWorkspaceUrl('/settings/preferences')
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onCreateNewChat}
          tooltip="New Chat"
          className="cursor-pointer"
          isActive={subPath === '/chats/new'}
        >
          <MessageCirclePlus className="size-[var(--icon-size-default)]" />
          <span>New Chat</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {showTasks && (
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Tasks" isActive={subPath.startsWith('/tasks')}>
            <NavLink to={tasksUrl}>
              <CheckSquare className="size-[var(--icon-size-default)]" />
              <span>Tasks</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      <SidebarMenuItem>
        {isMobile ? (
          <SidebarMenuButton
            onClick={onSettingsClick}
            isActive={subPath.startsWith('/settings')}
            className="cursor-pointer"
          >
            <Settings className="size-[var(--icon-size-default)]" />
            <span>Settings</span>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton asChild tooltip="Settings" isActive={subPath.startsWith('/settings')}>
            <NavLink to={settingsUrl}>
              <Settings className="size-[var(--icon-size-default)]" />
              <span>Settings</span>
            </NavLink>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    </>
  )
}
