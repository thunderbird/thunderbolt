/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { RecoveryContinuityNavDot, useRecoveryContinuityAttention } from '@/components/recovery-continuity'
import { useSettings } from '@/hooks/use-settings'
import { msg } from '@lingui/core/macro'
import { AudioLines, Bot, Cpu, Globe, Plug, SlidersHorizontal, Smartphone, Zap } from 'lucide-react'
import { SectionSidebar, type SectionNavGroup } from './section-sidebar'
import type { SidebarSection } from './types'

const preferencesPath = '/settings/preferences'

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
  const { experimentalFeatureVoice } = useSettings({ experimental_feature_voice: false })
  const attention = useRecoveryContinuityAttention()

  // Voice settings only exist to configure a custom (non-Thunderbolt) provider,
  // which is gated behind the experimental flag — hide the nav item otherwise.
  const groups = navGroups.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => experimentalFeatureVoice.value || item.path !== '/settings/voice')
      .map((item) =>
        item.path === preferencesPath
          ? {
              ...item,
              navigateTo: attention ? `${preferencesPath}#recovery-phrase-status` : undefined,
              trailing: <RecoveryContinuityNavDot placement="trailing" />,
            }
          : item,
      ),
  }))

  return (
    <SectionSidebar
      isCollapsed={isCollapsed}
      activeSection="settings"
      groups={groups}
      onSectionChange={onSectionChange}
      onNavigate={onSettingsNavigate}
      onSearchClick={onSearchClick}
    />
  )
}
