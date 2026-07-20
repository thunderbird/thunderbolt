/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { invoke } from '@tauri-apps/api/core'
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react'
import { isMacDesktop, isTauri } from './platform'
import { setAndroidBarColor } from './set-android-bar-color'

/** Sync native UI (keyboard, system controls) with the resolved theme on iOS. */
const syncNativeInterfaceStyle = (resolvedTheme: 'dark' | 'light') => {
  if (!isTauri()) {
    return
  }
  invoke('set_interface_style', { style: resolvedTheme }).catch(console.error)
}

/**
 * Match the native macOS window appearance to the app theme. The sidebar's
 * glass effect is an NSVisualEffectView behind the webview (src-tauri/src/lib.rs)
 * whose material follows the WINDOW appearance, not the app's CSS theme — without
 * this sync, app-light + system-dark renders the light sidebar over a dark blur.
 *
 * Takes the raw (unresolved) theme: 'system' must map to `null` (follow the OS)
 * rather than a forced value, because forcing the window theme also flips the
 * webview's `prefers-color-scheme` — pinning it would make 'system' resolve to
 * whatever was last forced instead of the real OS appearance.
 */
const syncMacWindowTheme = async (theme: Theme) => {
  if (!isMacDesktop()) {
    return
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTheme(theme === 'system' ? null : theme)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Read the theme's `--color-background` from CSS after the theme class has
 * been applied, so index.css stays the single runtime source of truth for the
 * page background (the pre-paint boot script in index.html is the one
 * unavoidable duplicate — it runs before the stylesheet loads).
 */
const readThemeBackgroundColor = (root: HTMLElement): string =>
  getComputedStyle(root).getPropertyValue('--color-background').trim()

/**
 * Pick the macOS vibrancy material per resolved theme. Dark uses HudWindow — a
 * neutral blur that passes the backdrop through distinctly. Light can't: a
 * neutral blur inherits the backdrop's luminance, so dark windows behind the
 * app turned the light sidebar murky no matter the CSS tint. Sheet is one of
 * the luminance-normalizing materials (like Finder's sidebar) — it pulls the
 * blur toward light so the glass stays bright over any backdrop.
 */
const syncMacWindowEffects = async (resolvedTheme: 'dark' | 'light') => {
  if (!isMacDesktop()) {
    return
  }
  try {
    const { getCurrentWindow, Effect, EffectState } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setEffects({
      effects: [resolvedTheme === 'dark' ? Effect.HudWindow : Effect.Sheet],
      state: EffectState.FollowsWindowActiveState,
    })
  } catch (error) {
    console.error(error)
  }
}

/** Apply a resolved theme to the document: root class, background, meta tag, and native chrome. */
const applyResolvedTheme = (resolvedTheme: 'dark' | 'light') => {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolvedTheme)

  const bgColor = readThemeBackgroundColor(root)
  root.style.backgroundColor = bgColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bgColor)

  void setAndroidBarColor(resolvedTheme === 'dark' ? 'light' : 'dark')
  syncNativeInterfaceStyle(resolvedTheme)
  void syncMacWindowEffects(resolvedTheme)
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

export type Theme = 'dark' | 'light' | 'system'

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
    void syncMacWindowTheme(theme)
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      applyResolvedTheme(systemTheme)
      return
    }
    applyResolvedTheme(theme)
  }, [theme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = () => {
      if (theme === 'system') {
        applyResolvedTheme(mediaQuery.matches ? 'dark' : 'light')
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
