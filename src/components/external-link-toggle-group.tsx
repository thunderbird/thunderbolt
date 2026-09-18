/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isExternalLinkBehavior, type ExternalLinkBehavior } from '@/lib/external-link-behavior'
import { isDesktop, isTauri } from '@/lib/platform'
import { trackEvent } from '@/lib/posthog'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { ExternalLink, MessageCircleQuestion, PanelRight, type LucideIcon } from 'lucide-react'

type BehaviorOption = {
  value: ExternalLinkBehavior
  ariaLabel: MessageDescriptor
  Icon: LucideIcon
  label: MessageDescriptor
}

// `msg` descriptors at module scope; the component resolves them with `i18n._` so
// the labels follow a language change. `browser` and `newTab` are two complete
// options rather than one with an interpolated label — "Open in {x}" built from
// fragments is untranslatable, since word order and the casing of the noun differ.
const ask: BehaviorOption = {
  value: 'ask',
  ariaLabel: msg`Always ask`,
  Icon: MessageCircleQuestion,
  label: msg`Ask`,
}
const sidebar: BehaviorOption = {
  value: 'sidebar',
  ariaLabel: msg`Open in sidebar`,
  Icon: PanelRight,
  label: msg`Sidebar`,
}
const browser: BehaviorOption = {
  value: 'browser',
  ariaLabel: msg`Open in browser`,
  Icon: ExternalLink,
  label: msg`Browser`,
}
const newTab: BehaviorOption = {
  value: 'browser',
  ariaLabel: msg`Open in new tab`,
  Icon: ExternalLink,
  label: msg`New tab`,
}

/**
 * Options for the current platform. `sidebar` needs the in-app side panel, which
 * only the desktop app has; the external option is a new tab on web, the OS
 * browser everywhere else.
 */
export const getBehaviorOptions = (deps = { isDesktop, isTauri }): BehaviorOption[] => [
  ask,
  ...(deps.isDesktop() ? [sidebar] : []),
  deps.isTauri() ? browser : newTab,
]

/** Where links in chats open — the Preferences counterpart to the confirmation dialog. */
export const ExternalLinkToggleGroup = () => {
  const { i18n } = useLingui()
  const externalLinkBehavior = useLocalSettingsStore((s) => s.externalLinkBehavior)
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)
  const options = getBehaviorOptions()

  // A persisted value with no option on this platform (e.g. `sidebar` carried into a
  // build without the side panel) would leave the group with nothing selected. Show
  // `ask`, which is also what such a click actually does — see `resolveLinkAction`.
  const value = options.some((option) => option.value === externalLinkBehavior) ? externalLinkBehavior : 'ask'

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(next) => {
        if (!isExternalLinkBehavior(next)) {
          return
        }
        setLocalSetting('externalLinkBehavior', next)
        trackEvent('settings_external_link_behavior_update', { behavior: next })
      }}
      className="justify-start rounded-lg"
    >
      {options.map(({ value, ariaLabel, Icon, label }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={i18n._(ariaLabel)}
          className="gap-2 px-4 cursor-pointer first:rounded-l-lg last:rounded-r-lg"
        >
          <Icon className="h-4 w-4" />
          {i18n._(label)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
