/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ThemeIcon } from './theme-icon'
import { useSiteTheme } from './use-site-theme'
import './site-theme.css'

const DevelopmentThemeToggle = () => {
  const { resolvedTheme, setPreference } = useSiteTheme()
  const next = resolvedTheme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${next} mode`

  return (
    <button
      className="site-theme-toggle"
      type="button"
      title={label}
      aria-label={label}
      onClick={() => setPreference(next)}
    >
      <span className="site-theme-light-icon">
        <ThemeIcon theme="light" />
      </span>
      <span className="site-theme-dark-icon">
        <ThemeIcon theme="dark" />
      </span>
    </button>
  )
}

export const SiteThemeToggle = () => (import.meta.env.DEV ? <DevelopmentThemeToggle /> : null)
