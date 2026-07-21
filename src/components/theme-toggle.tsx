/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { themeIcons } from '@/components/theme-icons'
import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/posthog'

const themeCycle = { light: 'dark', dark: 'system', system: 'light' } as const

/**
 * Single-icon theme toggle that cycles light → dark → system on each click.
 * The icon reflects the current setting; the label announces the action the
 * click performs. Dev-only — rendered in the sidebar footer's collapsed rail
 * and account row (the user-facing picker is `ThemeToggleGroup` on the
 * Preferences page).
 */
export const ThemeToggle = () => {
  const { theme, setTheme } = useTheme()
  const next = themeCycle[theme]
  const Icon = themeIcons[theme]
  const label = `Switch to ${next} theme`

  const handleClick = () => {
    setTheme(next)
    trackEvent('settings_theme_set', { theme: next })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center justify-center size-[var(--touch-height-default)] rounded-full transition-colors hover:bg-secondary/50 cursor-pointer select-none outline-none"
      aria-label={label}
      title={label}
    >
      <Icon className="size-[var(--icon-size-default)] text-muted-foreground" />
    </button>
  )
}
