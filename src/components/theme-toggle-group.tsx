/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { isTheme, themeIcons } from '@/components/theme-icons'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/posthog'

/** Three-way Light / Dark / System theme picker for the Preferences page. */
const themeOptions = [
  { value: 'light', ariaLabel: msg`Light mode`, Icon: themeIcons.light, label: msg`Light` },
  { value: 'dark', ariaLabel: msg`Dark mode`, Icon: themeIcons.dark, label: msg`Dark` },
  { value: 'system', ariaLabel: msg`System theme`, Icon: themeIcons.system, label: msg`System` },
] as const

export const ThemeToggleGroup = () => {
  const { theme, setTheme } = useTheme()
  const { i18n } = useLingui()

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={theme}
      onValueChange={(value) => {
        // Radix reports '' when the active item is clicked again — ignore it.
        if (!isTheme(value)) {
          return
        }
        setTheme(value)
        trackEvent('settings_theme_set', { theme: value })
      }}
      className="justify-start rounded-lg"
    >
      {themeOptions.map(({ value, ariaLabel, Icon, label }) => (
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
