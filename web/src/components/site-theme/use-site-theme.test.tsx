/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { SiteThemeToggle } from './site-theme-toggle'
import { type ResolvedTheme, type ThemePreference, useSiteTheme } from './use-site-theme'

let container: HTMLDivElement
let root: Root
let previousTheme: Window['thunderboltTheme'] | undefined
let previousDevelopment: string | undefined

beforeEach(() => {
  previousTheme = window.thunderboltTheme
  previousDevelopment = process.env.DEV
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  if (previousTheme) window.thunderboltTheme = previousTheme
  else Reflect.deleteProperty(window, 'thunderboltTheme')
  if (previousDevelopment === undefined) delete process.env.DEV
  else process.env.DEV = previousDevelopment
})

/** Model the pre-paint store's public contract; its browser/storage behavior is tested separately. */
const installThemeStore = () => {
  const state = { theme: 'dark' as ResolvedTheme, preference: 'auto' as ThemePreference }
  const listeners = new Set<() => void>()
  const update = (theme: ResolvedTheme) => {
    state.theme = theme
    listeners.forEach((listener) => listener())
  }
  const setPreference = mock((preference: ThemePreference) => {
    state.preference = preference
    update(preference === 'auto' ? 'dark' : preference)
  })
  window.thunderboltTheme = {
    getPreference: () => state.preference,
    getResolvedTheme: () => state.theme,
    setPreference,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { listeners, update, setPreference }
}

const ThemeReader = () => {
  const { resolvedTheme, setPreference } = useSiteTheme()
  return (
    <>
      <output>{resolvedTheme}</output>
      <button onClick={() => setPreference('auto')}>Use system setting</button>
    </>
  )
}

test('theme consumers follow store changes, forward System, and unsubscribe on unmount', async () => {
  const { listeners, update, setPreference } = installThemeStore()
  await act(async () => root.render(<ThemeReader />))
  expect(container.querySelector('output')!.textContent).toBe('dark')
  expect(listeners.size).toBe(1)
  await act(async () => update('light'))
  expect(container.querySelector('output')!.textContent).toBe('light')
  await act(async () => container.querySelector('button')!.click())
  expect(setPreference).toHaveBeenCalledWith('auto')
  expect(container.querySelector('output')!.textContent).toBe('dark')
  await act(async () => root.unmount())
  expect(listeners.size).toBe(0)
  update('light')
  expect(container.textContent).toBe('')
})

test('development toggle announces the next theme, switches both ways, and follows external changes', async () => {
  // Bun exposes import.meta.env through process.env; Astro replaces this flag at build time.
  process.env.DEV = 'true'
  const { setPreference, update } = installThemeStore()
  await act(async () => root.render(<SiteThemeToggle />))
  const button = container.querySelector('button')!
  expect(button.getAttribute('aria-label')).toBe('Switch to light mode')
  expect(button.title).toBe('Switch to light mode')
  expect(button.querySelectorAll('svg[aria-hidden=true]')).toHaveLength(2)
  await act(async () => button.click())
  expect(setPreference).toHaveBeenLastCalledWith('light')
  expect(button.getAttribute('aria-label')).toBe('Switch to dark mode')
  await act(async () => button.click())
  expect(setPreference).toHaveBeenLastCalledWith('dark')
  expect(button.getAttribute('aria-label')).toBe('Switch to light mode')
  await act(async () => update('light'))
  expect(button.getAttribute('aria-label')).toBe('Switch to dark mode')
})

test('server rendering needs no browser store or subscription', () => {
  Reflect.deleteProperty(window, 'thunderboltTheme')
  expect(renderToString(<ThemeReader />)).toContain('<output>light</output>')
})

test('outside development the toggle renders no control and never subscribes', async () => {
  delete process.env.DEV
  const { listeners } = installThemeStore()
  await act(async () => root.render(<SiteThemeToggle />))
  expect(container.querySelector('button')).toBeNull()
  expect(listeners.size).toBe(0)
})
