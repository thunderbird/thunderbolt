/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Monitor, Moon, Sun } from 'lucide-react'

import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'

const themeCycle = { light: 'dark', dark: 'system', system: 'light' } as const

const themeMeta = {
  light: { icon: Sun, label: 'Light theme' },
  dark: { icon: Moon, label: 'Dark theme' },
  system: { icon: Monitor, label: 'System theme' },
} as const

/**
 * Single-icon theme toggle that cycles light → dark → system on each click.
 * The icon reflects the current setting. Lives in the header next to the sync
 * status indicator.
 */
export const ThemeToggle = ({ className }: { className?: string }) => {
  const { theme, setTheme } = useTheme()
  const { icon: Icon, label } = themeMeta[theme]

  const handleClick = () => {
    const next = themeCycle[theme]
    setTheme(next)
    trackEvent('settings_theme_set', { theme: next })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex items-center justify-center size-[var(--touch-height-sm)] rounded-full transition-colors',
        'hover:bg-secondary/50 cursor-pointer select-none outline-none',
        className,
      )}
      aria-label={label}
    >
      <Icon className="size-[var(--icon-size-default)] text-muted-foreground" />
    </button>
  )
}
