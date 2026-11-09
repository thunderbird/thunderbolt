/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../polyfills'
import '../index.css'
import { useConfigStore } from '@/api/config-store'
import { i18n, showLocale } from '@/i18n'
import { readInitialLocale } from '@/i18n/active-locale'
import { useResolveTheme, useThemeSetting } from '@/lib/theme-provider'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { QuickEntry } from './quick-entry'

document.documentElement.classList.add('force-desktop')

// Pasted-file previews (`FileCard`) load some content through react-query.
const queryClient = new QueryClient()

/**
 * Follow the language the main window last published. This window never
 * publishes one itself: it boots hidden and lives for the whole session, so
 * anything it wrote would be the locale it read at launch.
 */
const followMainWindowLocale = () => {
  const locale = readInitialLocale()
  document.documentElement.lang = locale
  void showLocale(locale)
}

followMainWindowLocale()

// Re-read what the main window may have changed since launch each time the
// panel comes up: language, theme and branding.
window.addEventListener('focus', () => {
  followMainWindowLocale()
  void useLocalSettingsStore.persist.rehydrate()
  void useConfigStore.persist.rehydrate()
})

const QuickEntryApp = () => {
  const theme = useThemeSetting()
  const resolvedTheme = useResolveTheme(theme)

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(resolvedTheme)
  }, [resolvedTheme])

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <QuickEntry />
      </I18nProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<QuickEntryApp />)
