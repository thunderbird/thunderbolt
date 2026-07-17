/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarFooter } from '@/components/sidebar-footer'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Bot, Cpu, Plug, Server, SlidersHorizontal, Smartphone, Zap } from 'lucide-react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import type { SidebarSection } from './types'

type SettingsSidebarContentProps = {
  isCollapsed: boolean
  showTasks: boolean
  onSectionChange: (section: SidebarSection) => void
  onSettingsNavigate: (path: string) => void
}

export const SettingsSidebarContent = ({
  isCollapsed,
  showTasks,
  onSectionChange,
  onSettingsNavigate,
}: SettingsSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()

  // Collapsed rail: the group labels are hidden, so a hairline divider takes
  // over as the section boundary.
  const groupDivider = isCollapsed ? <RailDivider /> : null

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader
        onToggle={toggleSidebar}
        navToggle={
          <SidebarNavToggle activeSection="settings" showTasks={showTasks} onSectionChange={onSectionChange} />
        }
      />

      {isCollapsed && (
        // pb-0: the next group's own top padding provides the 8px gap,
        // matching the toggle→New Chat spacing on the chats rail.
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarNavToggle
              vertical
              activeSection="settings"
              showTasks={showTasks}
              onSectionChange={onSectionChange}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      {/* Collapsed: SidebarContent's gap-2 alone spaces the groups and their
          dividers, so the groups' own vertical padding would double it. */}
      <SidebarGroup className={isCollapsed ? 'py-0' : undefined}>
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/agents')}
                tooltip="All agents"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/agents'}
              >
                <Bot className="size-4" />
                <span>All agents</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {groupDivider}

      <SidebarGroup className={isCollapsed ? 'py-0' : undefined}>
        <SidebarGroupLabel>What agents use</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/skills')}
                tooltip="Skills"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/skills'}
              >
                <Zap className="size-4" />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/models')}
                tooltip="Models"
                className="cursor-pointer"
                isActive={location.pathname.startsWith('/settings/models')}
              >
                <Cpu className="size-4" />
                <span>Models</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/integrations')}
                tooltip="Integrations"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/integrations'}
              >
                <Plug className="size-4" />
                <span>Integrations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/mcp-servers')}
                tooltip="MCP Servers"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/mcp-servers'}
              >
                <Server className="size-4" />
                <span>MCP Servers</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {groupDivider}

      <SidebarGroup className={isCollapsed ? 'pt-0' : undefined}>
        <SidebarGroupLabel>Settings</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/preferences')}
                tooltip="Preferences"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/preferences'}
              >
                <SlidersHorizontal className="size-4" />
                <span>Preferences</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/devices')}
                tooltip="Devices"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/devices'}
              >
                <Smartphone className="size-4" />
                <span>Devices</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <div className="flex-1" />

      <SidebarFooter />
    </SidebarContent>
  )
}
