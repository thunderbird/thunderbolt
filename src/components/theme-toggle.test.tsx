/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { ThemeProvider } from '@/lib/theme-provider'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { ThemeToggle } from './theme-toggle'

// Rendered under the REAL ThemeProvider — mocking `@/lib/theme-provider` with
// `mock.module` is process-global and breaks sibling suites (the group picker
// test) under `--randomize`. Theme state is driven through the settings store.
const renderToggle = (theme: 'light' | 'dark' | 'system') => {
  useLocalSettingsStore.getState().setLocalSetting('theme', theme)
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  )
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('theme', 'system')
  })

  afterEach(() => {
    cleanup()
    // Don't leak a persisted theme into other suites.
    useLocalSettingsStore.getState().setLocalSetting('theme', 'system')
    document.documentElement.classList.remove('light', 'dark')
  })

  it('labels the button with the action it performs', () => {
    renderToggle('dark')

    expect(screen.getByRole('button', { name: 'Switch to system theme' })).toBeInTheDocument()
  })

  it('cycles light → dark', () => {
    renderToggle('light')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))

    expect(useLocalSettingsStore.getState().theme).toBe('dark')
  })

  it('cycles dark → system', () => {
    renderToggle('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to system theme' }))

    expect(useLocalSettingsStore.getState().theme).toBe('system')
  })

  it('cycles system → light', () => {
    renderToggle('system')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))

    expect(useLocalSettingsStore.getState().theme).toBe('light')
  })
})
