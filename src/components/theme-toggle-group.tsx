/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTheme, themeIcons } from '@/components/theme-icons'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/posthog'

/**
 * Three-way Light / Dark / System theme picker for the Preferences page.
 * (The sidebar footer's compact cycling icon lives in `theme-toggle.tsx`
 * and is dev-only.)
 */
const themeOptions = [
  { value: 'light', ariaLabel: 'Light mode', Icon: themeIcons.light, label: 'Light' },
  { value: 'dark', ariaLabel: 'Dark mode', Icon: themeIcons.dark, label: 'Dark' },
  { value: 'system', ariaLabel: 'System theme', Icon: themeIcons.system, label: 'System' },
] as const

export const ThemeToggleGroup = () => {
  const { theme, setTheme } = useTheme()

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
          aria-label={ariaLabel}
          className="gap-2 px-4 cursor-pointer first:rounded-l-lg last:rounded-r-lg"
        >
          <Icon className="h-4 w-4" />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
