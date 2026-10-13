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
import { cn } from '@/lib/utils'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import type { LucideIcon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import type { SidebarSection } from './types'

export type SectionNavItem = {
  path: string
  label: MessageDescriptor
  icon: LucideIcon
  matchPrefix?: boolean
}

export type SectionNavGroup = { id: string; label: MessageDescriptor; items: SectionNavItem[] }

/** The shared sidebar frame for settings and optional application sections. */
export const SectionSidebar = ({
  isCollapsed,
  onSectionChange,
  onNavigate,
  activeSection,
  groups,
  footer = <SidebarFooter />,
}: {
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onNavigate: (path: string) => void
  activeSection: SidebarSection
  groups: SectionNavGroup[]
  footer?: ReactNode
}) => {
  const { i18n } = useLingui()
  const { isMobile, toggleSidebar } = useSidebar()
  const location = useLocation()
  const isItemActive = ({ path, matchPrefix }: SectionNavItem) =>
    matchPrefix ? location.pathname.startsWith(path) : location.pathname === path

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader
        onToggle={toggleSidebar}
        navToggle={<SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} />}
      />

      {isCollapsed && (
        // pb-0: the next group's own top padding provides the 8px gap,
        // matching the toggle→New Chat spacing on the chats rail. pt-2 gives
        // the toggle the same 8px above as the rail leaves on its sides.
        <SidebarGroup className="pt-2 pb-0">
          <SidebarGroupContent>
            <SidebarNavToggle vertical activeSection={activeSection} onSectionChange={onSectionChange} />
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
                <SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} />
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
                      onClick={() => onNavigate(item.path)}
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

      {footer}
    </SidebarContent>
  )
}
