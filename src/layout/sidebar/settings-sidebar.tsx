/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { RecoveryContinuityNavDot, useRecoveryContinuityAttention } from '@/components/recovery-continuity'
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
import {
  AudioLines,
  Brain,
  Bot,
  Cpu,
  Globe,
  Plug,
  SlidersHorizontal,
  Smartphone,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Fragment } from 'react'
import { useLocation } from 'react-router'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import { SidebarHeaderActions } from './sidebar-header-actions'
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
const preferencesPath = '/settings/preferences'

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
      { path: '/settings/memory', label: msg`Memory`, icon: Brain },
      { path: '/settings/connections', label: msg`Connections`, icon: Plug },
      { path: '/settings/models', label: msg`Models`, icon: Cpu, matchPrefix: true },
      { path: '/settings/search', label: msg`Search`, icon: Globe },
      { path: '/settings/voice', label: msg`Voice`, icon: AudioLines },
    ],
  },
  {
    id: 'settings',
    label: msg`Settings`,
    items: [
      { path: preferencesPath, label: msg`Preferences`, icon: SlidersHorizontal },
      { path: '/settings/devices', label: msg`Devices`, icon: Smartphone },
    ],
  },
]

type SettingsSidebarContentProps = {
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onSettingsNavigate: (path: string) => void
  onSearchClick?: () => void
}

export const SettingsSidebarContent = ({
  isCollapsed,
  onSectionChange,
  onSettingsNavigate,
  onSearchClick,
}: SettingsSidebarContentProps) => {
  const { i18n } = useLingui()
  const { isMobile, toggleSidebar } = useSidebar()
  const location = useLocation()
  const { experimentalFeatureVoice } = useSettings({ experimental_feature_voice: false })
  const attention = useRecoveryContinuityAttention()

  const isItemActive = ({ path, matchPrefix }: NavItem) =>
    matchPrefix ? location.pathname.startsWith(path) : location.pathname === path

  // Voice settings only exist to configure a custom (non-Thunderbolt) provider,
  // which is gated behind the experimental flag — hide the nav item otherwise.
  const groups = experimentalFeatureVoice.value
    ? navGroups
    : navGroups.map((group) => ({ ...group, items: group.items.filter((item) => item.path !== '/settings/voice') }))

  const headerControls = (
    <SidebarHeaderActions onSearchClick={onSearchClick}>
      <SidebarNavToggle activeSection="settings" onSectionChange={onSectionChange} />
    </SidebarHeaderActions>
  )

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader onToggle={toggleSidebar} navToggle={headerControls} />

      {isCollapsed && (
        <SidebarGroup className="pt-2 pb-0">
          <SidebarGroupContent>
            <SidebarHeaderActions vertical onSearchClick={onSearchClick}>
              <SidebarNavToggle vertical activeSection="settings" onSectionChange={onSectionChange} />
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
                      onClick={() =>
                        onSettingsNavigate(
                          attention && item.path === preferencesPath
                            ? `${preferencesPath}#recovery-phrase-status`
                            : item.path,
                        )
                      }
                      tooltip={i18n._(item.label)}
                      className="cursor-pointer"
                      isActive={isItemActive(item)}
                    >
                      <item.icon className="size-4" />
                      <span>{i18n._(item.label)}</span>
                      {item.path === preferencesPath && <RecoveryContinuityNavDot placement="trailing" />}
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
