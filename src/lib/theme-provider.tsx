/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { invoke } from '@tauri-apps/api/core'
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react'
import { isTauri } from './platform'
import { setAndroidBarColor } from './set-android-bar-color'

/** Sync native UI (keyboard, system controls) with the resolved theme on iOS. */
const syncNativeInterfaceStyle = (resolvedTheme: 'dark' | 'light') => {
  if (!isTauri()) {
    return
  }
  invoke('set_interface_style', { style: resolvedTheme }).catch(console.error)
}

/**
 * Mirror theme to Tauri's plugin-store so native code can read it at startup.
 * Currently the Rust side doesn't read this yet — it will once we upgrade to
 * Tauri 2.10.3+ which supports WebView background color on macOS. At that point
 * the Rust setup() can read theme.json and set the correct WebView background
 * before HTML loads, eliminating the need for the hidden-window workaround.
 */
const persistThemeToNativeStore = async (theme: string) => {
  if (!isTauri()) {
    return
  }
  const { Store } = await import('@tauri-apps/plugin-store')
  const store = await Store.load('theme.json')
  await store.set('theme', theme)
}

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const theme = useLocalSettingsStore((s) => s.theme)
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)

  const setTheme = useCallback((newTheme: Theme) => setLocalSetting('theme', newTheme), [setLocalSetting])

  useEffect(() => {
    persistThemeToNativeStore(theme).catch(() => {})
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')

    root.classList.remove('light', 'dark')

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

      root.classList.add(systemTheme)

      const bgColor = systemTheme === 'dark' ? '#0a0a0a' : '#fff'
      root.style.backgroundColor = bgColor
      metaThemeColor?.setAttribute('content', bgColor)

      void setAndroidBarColor(systemTheme === 'dark' ? 'light' : 'dark')
      syncNativeInterfaceStyle(systemTheme)

      return
    }

    root.classList.add(theme)

    const bgColor = theme === 'dark' ? '#0a0a0a' : '#fff'
    root.style.backgroundColor = bgColor
    metaThemeColor?.setAttribute('content', bgColor)

    void setAndroidBarColor(theme === 'dark' ? 'light' : 'dark')
    syncNativeInterfaceStyle(theme)
  }, [theme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = () => {
      if (theme === 'system') {
        const root = window.document.documentElement
        const metaThemeColor = document.querySelector('meta[name="theme-color"]')
        root.classList.remove('light', 'dark')

        const systemTheme = mediaQuery.matches ? 'dark' : 'light'
        root.classList.add(systemTheme)

        const bgColor = systemTheme === 'dark' ? '#0a0a0a' : '#fff'
        root.style.backgroundColor = bgColor
        metaThemeColor?.setAttribute('content', bgColor)

        void setAndroidBarColor(systemTheme === 'dark' ? 'light' : 'dark')
        syncNativeInterfaceStyle(systemTheme)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  const value = {
    theme,
    setTheme,
  }

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }

  return context
}
