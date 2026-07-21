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
import { Bot, Cpu, Plug, Server, SlidersHorizontal, Smartphone, Zap, type LucideIcon } from 'lucide-react'
import { Fragment } from 'react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import type { SidebarSection } from './types'

type NavItem = {
  path: string
  label: string
  icon: LucideIcon
  /** Match sub-routes too (e.g. /settings/models/:id). Default: exact match. */
  matchPrefix?: boolean
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Agents',
    items: [{ path: '/settings/agents', label: 'All agents', icon: Bot }],
  },
  {
    label: 'What agents use',
    items: [
      { path: '/settings/skills', label: 'Skills', icon: Zap },
      { path: '/settings/models', label: 'Models', icon: Cpu, matchPrefix: true },
      { path: '/settings/integrations', label: 'Integrations', icon: Plug },
      { path: '/settings/mcp-servers', label: 'MCP servers', icon: Server },
    ],
  },
  {
    label: 'Settings',
    items: [
      { path: '/settings/preferences', label: 'Preferences', icon: SlidersHorizontal },
      { path: '/settings/devices', label: 'Devices', icon: Smartphone },
    ],
  },
]

type SettingsSidebarContentProps = {
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onSettingsNavigate: (path: string) => void
}

export const SettingsSidebarContent = ({
  isCollapsed,
  onSectionChange,
  onSettingsNavigate,
}: SettingsSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()

  const isItemActive = ({ path, matchPrefix }: NavItem) =>
    matchPrefix ? location.pathname.startsWith(path) : location.pathname === path

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader
        onToggle={toggleSidebar}
        navToggle={<SidebarNavToggle activeSection="settings" onSectionChange={onSectionChange} />}
      />

      {isCollapsed && (
        // pb-0: the next group's own top padding provides the 8px gap,
        // matching the toggle→New Chat spacing on the chats rail. pt-2 gives
        // the toggle the same 8px above as the rail leaves on its sides.
        <SidebarGroup className="pt-2 pb-0">
          <SidebarGroupContent>
            <SidebarNavToggle vertical activeSection="settings" onSectionChange={onSectionChange} />
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      {navGroups.map((group, index) => (
        <Fragment key={group.label}>
          {/* Collapsed rail: the group labels are hidden, so a hairline
              divider takes over as the section boundary. */}
          {index > 0 && isCollapsed && <RailDivider />}
          {/* Collapsed: SidebarContent's gap-2 alone spaces the groups and
              their dividers, so the groups' own vertical padding would double
              it. The last group keeps its bottom padding against the footer. */}
          <SidebarGroup className={isCollapsed ? (index === navGroups.length - 1 ? 'pt-0' : 'py-0') : undefined}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      onClick={() => onSettingsNavigate(item.path)}
                      tooltip={item.label}
                      className="cursor-pointer"
                      isActive={isItemActive(item)}
                    >
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}

      <div className="flex-1" />

      <SidebarFooter navToggle={<SidebarNavToggle activeSection="settings" onSectionChange={onSectionChange} />} />
    </SidebarContent>
  )
}
