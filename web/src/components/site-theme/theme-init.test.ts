/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { ThemePreference } from './use-site-theme'

const source = readFileSync(new URL('./theme-init.js', import.meta.url), 'utf8')

/** Run the actual pre-paint script with a saved preference and an OS theme. */
const createPage = (saved: string | null, isDark = false, development = true, blockedStorage = false) => {
  const storage = new Map(saved === null ? [] : [['starlight-theme', saved]])
  const root = { dataset: {} as Record<string, string> }
  const system = Object.assign(new EventTarget(), { matches: isDark })
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => system,
    thunderboltTheme: {} as {
      getPreference: () => ThemePreference
      getResolvedTheme: () => 'light' | 'dark'
      setPreference: (theme: ThemePreference) => void
      subscribe: (listener: () => void) => () => void
    },
  })
  runInNewContext(source, {
    document: { documentElement: root, currentScript: { dataset: { themeControls: String(development) } } },
    window,
    localStorage: {
      getItem: (key: string) => {
        if (blockedStorage) throw new Error('Storage access denied')
        return storage.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (blockedStorage) throw new Error('Storage access denied')
        storage.set(key, value)
      },
    },
  })
  return { root, storage, system, window, theme: window.thunderboltTheme }
}

describe('shared site theme', () => {
  test.each(['light', 'dark'])('production ignores a saved %s override and follows live OS changes', (saved) => {
    const { root, system, theme, storage, window } = createPage(saved, true, false)
    expect(root.dataset).toEqual({ theme: 'dark', themePreference: 'auto' })
    theme.setPreference('light')
    expect(theme.getResolvedTheme()).toBe('dark')
    expect(storage.get('starlight-theme')).toBe(saved)
    system.matches = false
    system.dispatchEvent(new Event('change'))
    expect(theme.getResolvedTheme()).toBe('light')
    storage.set('starlight-theme', 'dark')
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'starlight-theme' }))
    expect(theme.getResolvedTheme()).toBe('light')
    expect(theme.getPreference()).toBe('auto')
  })

  test('applies an existing docs preference before the page renders', () => {
    const { root, theme } = createPage('light', true)
    expect(root.dataset).toEqual({ theme: 'light', themePreference: 'light' })
    expect(theme.getResolvedTheme()).toBe('light')
  })

  test.each([null, '', 'auto', 'unexpected'])('uses the OS theme for %p', (saved) => {
    expect(createPage(saved, true).root.dataset.theme).toBe('dark')
    expect(createPage(saved, false).root.dataset.theme).toBe('light')
  })

  test('follows OS changes only while System is selected', () => {
    const { system, theme } = createPage(null)
    system.matches = true
    system.dispatchEvent(new Event('change'))
    expect(theme.getResolvedTheme()).toBe('dark')
    theme.setPreference('light')
    system.dispatchEvent(new Event('change'))
    expect(theme.getResolvedTheme()).toBe('light')
  })

  test('persists choices for navigation and restores System without pinning the OS color', () => {
    const { storage, theme } = createPage(null, true)
    theme.setPreference('light')
    expect(createPage(storage.get('starlight-theme')!).theme.getResolvedTheme()).toBe('light')
    theme.setPreference('auto')
    expect(storage.get('starlight-theme')).toBe('')
    expect(theme.getResolvedTheme()).toBe('dark')
  })

  test('updates subscribed controls when another tab changes or clears the preference', () => {
    const { storage, window, theme } = createPage('light', true)
    const updates: string[] = []
    const unsubscribe = theme.subscribe(() => updates.push(theme.getResolvedTheme()))
    storage.set('starlight-theme', 'dark')
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'starlight-theme' }))
    expect(theme.getPreference()).toBe('dark')
    storage.clear()
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(theme.getPreference()).toBe('auto')
    expect(updates).toEqual(['dark', 'dark'])
    unsubscribe()
    theme.setPreference('light')
    expect(updates).toHaveLength(2)
  })

  test('ignores storage events for unrelated settings', () => {
    const { storage, window, theme } = createPage('light')
    storage.set('starlight-theme', 'dark')
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'another-setting' }))
    expect(theme.getResolvedTheme()).toBe('light')
  })
})

test('blocked preview storage does not disable theme initialization or in-memory controls', () => {
  const { root, theme, system } = createPage('light', true, true, true)
  expect(root.dataset.theme).toBe('dark')
  theme.setPreference('light')
  expect(root.dataset.theme).toBe('light')
  system.matches = false
  system.dispatchEvent(new Event('change'))
  expect(root.dataset.theme).toBe('light')
  theme.setPreference('auto')
  system.matches = true
  system.dispatchEvent(new Event('change'))
  expect(root.dataset.theme).toBe('dark')
})

test('production never needs storage access, even when storage is blocked', () => {
  const { root, theme } = createPage('light', true, false, true)
  theme.setPreference('light')
  expect(root.dataset.theme).toBe('dark')
})
