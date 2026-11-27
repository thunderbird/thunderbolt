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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useFormatters } from '@/i18n/use-formatters'
import { cn } from '@/lib/utils'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import type { LucideIcon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { useVisibleSections } from './use-visible-sections'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import { SidebarHeaderActions } from './sidebar-header-actions'
import type { SidebarSection } from './types'

export type SectionNavItem = {
  path: string
  label: MessageDescriptor
  icon: LucideIcon
  /** Match sub-routes too (e.g. /settings/models/:id). Default: exact match. */
  matchPrefix?: boolean
  /** Where a click goes, when that differs from `path` (e.g. a hash on the page). */
  navigateTo?: string
  /** Rendered after the label, inside the button. */
  trailing?: ReactNode
  /** A count for the item, read by a hook: null or 0 hides it, and above 99 shows `99+`. */
  useBadge?: () => number | null
}

/** `id` carries the React key, since the label is a descriptor rather than a string. */
export type SectionNavGroup = { id: string; label: MessageDescriptor; items: SectionNavItem[] }

/** Its own component so each item's badge hook runs at a stable call site, never inside the map. */
const NavItemBadge = ({ useBadge }: { useBadge: () => number | null }) => {
  const count = useBadge()
  const formatters = useFormatters()
  if (!count) {
    return null
  }
  return <SidebarMenuBadge>{count > 99 ? `${formatters.number(99)}+` : formatters.number(count)}</SidebarMenuBadge>
}

/** The shared sidebar frame for settings and optional application sections. */
export const SectionSidebar = ({
  isCollapsed,
  onSectionChange,
  onNavigate,
  onSearchClick,
  activeSection,
  groups,
  footer = <SidebarFooter />,
}: {
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onNavigate: (path: string) => void
  onSearchClick?: () => void
  activeSection: SidebarSection
  groups: SectionNavGroup[]
  footer?: ReactNode
}) => {
  const { i18n } = useLingui()
  const { isMobile, toggleSidebar } = useSidebar()
  const sections = useVisibleSections()
  const location = useLocation()
  const headerControls = (
    <SidebarHeaderActions onSearchClick={onSearchClick}>
      <SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} sections={sections} />
    </SidebarHeaderActions>
  )
  const isItemActive = ({ path, matchPrefix }: SectionNavItem) =>
    matchPrefix ? location.pathname.startsWith(path) : location.pathname === path

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader onToggle={toggleSidebar} navToggle={headerControls} />

      {isCollapsed && (
        // pb-0: the next group's own top padding provides the 8px gap,
        // matching the toggle→New Chat spacing on the chats rail. pt-2 gives
        // the toggle the same 8px above as the rail leaves on its sides.
        <SidebarGroup className="pt-2 pb-0">
          <SidebarGroupContent>
            <SidebarHeaderActions vertical onSearchClick={onSearchClick}>
              <SidebarNavToggle
                vertical
                activeSection={activeSection}
                onSectionChange={onSectionChange}
                sections={sections}
              />
            </SidebarHeaderActions>
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
              <div className="flex h-[var(--touch-height-lg)] items-center">{headerControls}</div>
            )}
            <SidebarGroupLabel className={isMobile && index === 0 ? 'mt-1' : undefined}>
              {i18n._(group.label)}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      onClick={() => onNavigate(item.navigateTo ?? item.path)}
                      tooltip={i18n._(item.label)}
                      className="cursor-pointer"
                      isActive={isItemActive(item)}
                    >
                      <item.icon className="size-4" />
                      <span>{i18n._(item.label)}</span>
                      {item.trailing}
                    </SidebarMenuButton>
                    {item.useBadge && <NavItemBadge useBadge={item.useBadge} />}
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
