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
import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { AudioLines, Bot, Cpu, Plug, SlidersHorizontal, Smartphone, Zap, type LucideIcon } from 'lucide-react'
import { Fragment } from 'react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import type { SidebarSection } from './types'

type NavItem = {
  path: string
  label: MessageDescriptor
  icon: LucideIcon
  /** Match sub-routes too (e.g. /settings/models/:id). Default: exact match. */
  matchPrefix?: boolean
}

/** `id` carries the React key, since the label is now a descriptor rather than
 *  a string the reconciler can compare. */
const navGroups: { id: string; label: MessageDescriptor; items: NavItem[] }[] = [
  {
    id: 'agents',
    label: msg`Agents`,
    items: [{ path: '/settings/agents', label: msg`All agents`, icon: Bot }],
  },
  {
    id: 'what-agents-use',
    label: msg`What agents use`,
    items: [
      { path: '/settings/skills', label: msg`Skills`, icon: Zap },
      { path: '/settings/connections', label: msg`Connections`, icon: Plug },
      { path: '/settings/models', label: msg`Models`, icon: Cpu, matchPrefix: true },
      { path: '/settings/voice', label: msg`Voice`, icon: AudioLines },
    ],
  },
  {
    id: 'settings',
    label: msg`Settings`,
    items: [
      { path: '/settings/preferences', label: msg`Preferences`, icon: SlidersHorizontal },
      { path: '/settings/devices', label: msg`Devices`, icon: Smartphone },
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
  const { i18n } = useLingui()
  const { isMobile, toggleSidebar } = useSidebar()
  const location = useLocation()
  const { experimentalFeatureVoice } = useSettings({ experimental_feature_voice: false })

  const isItemActive = ({ path, matchPrefix }: NavItem) =>
    matchPrefix ? location.pathname.startsWith(path) : location.pathname === path

  // Voice settings only exist to configure a custom (non-Thunderbolt) provider,
  // which is gated behind the experimental flag — hide the nav item otherwise.
  const groups = experimentalFeatureVoice.value
    ? navGroups
    : navGroups.map((group) => ({ ...group, items: group.items.filter((item) => item.path !== '/settings/voice') }))

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

      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {/* Collapsed rail: the group labels are hidden, so a hairline
              divider takes over as the section boundary. */}
          {index > 0 && isCollapsed && <RailDivider />}
          {/* Collapsed: SidebarContent's gap-2 alone spaces the groups and
              their dividers, so the groups' own vertical padding would double
              it. The last group keeps its bottom padding against the footer. */}
          <SidebarGroup
            className={cn(
              isCollapsed ? (index === groups.length - 1 ? 'pt-0' : 'py-0') : undefined,
              isMobile && index === 0 && 'pt-[calc(var(--header-safe-area-top)+0.5rem)]',
            )}
          >
            {isMobile && index === 0 && (
              <div className="flex h-[var(--touch-height-lg)] items-center">
                <SidebarNavToggle activeSection="settings" onSectionChange={onSectionChange} />
              </div>
            )}
            <SidebarGroupLabel className={isMobile && index === 0 ? 'mt-1' : undefined}>
              {i18n._(group.label)}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      onClick={() => onSettingsNavigate(item.path)}
                      tooltip={i18n._(item.label)}
                      className="cursor-pointer"
                      isActive={isItemActive(item)}
                    >
                      <item.icon className="size-4" />
                      <span>{i18n._(item.label)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}

      <div className="flex-1" />

      <SidebarFooter />
    </SidebarContent>
  )
}
