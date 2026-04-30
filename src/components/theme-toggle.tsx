/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Monitor, Moon, Sun } from 'lucide-react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/posthog'

export const ThemeToggle = () => {
  const { theme, setTheme } = useTheme()

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={theme}
      onValueChange={(value) => {
        if (!value) {
          return
        }
        setTheme(value as 'light' | 'dark' | 'system')
        trackEvent('settings_theme_set', { theme: value })
      }}
      className="justify-start rounded-lg"
    >
      <ToggleGroupItem
        value="light"
        aria-label="Light mode"
        className="gap-2 px-4 cursor-pointer first:rounded-l-lg last:rounded-r-lg"
      >
        <Sun className="h-4 w-4" />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem
        value="dark"
        aria-label="Dark mode"
        className="gap-2 px-4 cursor-pointer first:rounded-l-lg last:rounded-r-lg"
      >
        <Moon className="h-4 w-4" />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem
        value="system"
        aria-label="System theme"
        className="gap-2 px-4 cursor-pointer first:rounded-l-lg last:rounded-r-lg"
      >
        <Monitor className="h-4 w-4" />
        System
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
