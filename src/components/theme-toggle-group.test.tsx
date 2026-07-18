/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { ThemeProvider } from '@/lib/theme-provider'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { ThemeToggleGroup } from './theme-toggle-group'

// Rendered under the REAL ThemeProvider (no module mocks): the provider only
// touches the DOM root class and matchMedia on web, both available here.
const renderGroup = () =>
  render(
    <ThemeProvider>
      <ThemeToggleGroup />
    </ThemeProvider>,
  )

describe('ThemeToggleGroup', () => {
  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('theme', 'system')
  })

  afterEach(() => {
    cleanup()
    // Don't leak a persisted theme into other suites.
    useLocalSettingsStore.getState().setLocalSetting('theme', 'system')
    document.documentElement.classList.remove('light', 'dark')
  })

  it('renders all three options with the current theme selected', () => {
    renderGroup()

    expect(screen.getByRole('radio', { name: 'Light mode' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Dark mode' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute('data-state', 'on')
  })

  it('selecting an option persists the theme and applies the root class', () => {
    renderGroup()

    fireEvent.click(screen.getByRole('radio', { name: 'Dark mode' }))

    expect(useLocalSettingsStore.getState().theme).toBe('dark')
    expect(screen.getByRole('radio', { name: 'Dark mode' })).toHaveAttribute('data-state', 'on')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('re-clicking the selected option keeps it selected (no deselect to empty)', () => {
    renderGroup()

    fireEvent.click(screen.getByRole('radio', { name: 'System theme' }))

    expect(useLocalSettingsStore.getState().theme).toBe('system')
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute('data-state', 'on')
  })
})
