/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSettings } from '@/hooks/use-settings'
import { msg } from '@lingui/core/macro'
import { AudioLines, Bot, Cpu, Plug, SlidersHorizontal, Smartphone, Zap } from 'lucide-react'
import { SectionSidebar, type SectionNavGroup } from './section-sidebar'
import type { SidebarSection } from './types'

const navGroups: SectionNavGroup[] = [
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
  const { experimentalFeatureVoice } = useSettings({ experimental_feature_voice: false })

  // Voice settings only exist to configure a custom (non-Thunderbolt) provider,
  // which is gated behind the experimental flag — hide the nav item otherwise.
  const groups = experimentalFeatureVoice.value
    ? navGroups
    : navGroups.map((group) => ({ ...group, items: group.items.filter((item) => item.path !== '/settings/voice') }))

  return (
    <SectionSidebar
      isCollapsed={isCollapsed}
      activeSection="settings"
      groups={groups}
      onSectionChange={onSectionChange}
      onNavigate={onSettingsNavigate}
    />
  )
}
