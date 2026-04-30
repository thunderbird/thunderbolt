/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ThemeToggle } from './theme-toggle'

// Mock useTheme hook
const mockSetTheme = mock()
let mockTheme = 'system'

mock.module('@/lib/theme-provider', () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
  }),
}))

describe('ThemeToggle', () => {
  beforeEach(() => {
    mockTheme = 'system'
    mockSetTheme.mockClear()
  })

  afterEach(() => {
    mockSetTheme.mockClear()
  })

  describe('rendering', () => {
    it('renders all theme options', () => {
      render(<ThemeToggle />)

      expect(screen.getByRole('radio', { name: 'Light mode' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Dark mode' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'System theme' })).toBeInTheDocument()
    })

    it('displays theme labels', () => {
      render(<ThemeToggle />)

      expect(screen.getByText('Light')).toBeInTheDocument()
      expect(screen.getByText('Dark')).toBeInTheDocument()
      expect(screen.getByText('System')).toBeInTheDocument()
    })
  })

  describe('theme selection', () => {
    it('calls setTheme when selecting light theme', () => {
      render(<ThemeToggle />)

      fireEvent.click(screen.getByRole('radio', { name: 'Light mode' }))

      expect(mockSetTheme).toHaveBeenCalledWith('light')
    })

    it('calls setTheme when selecting dark theme', () => {
      render(<ThemeToggle />)

      fireEvent.click(screen.getByRole('radio', { name: 'Dark mode' }))

      expect(mockSetTheme).toHaveBeenCalledWith('dark')
    })

    it('calls setTheme when selecting system theme', () => {
      mockTheme = 'light'
      render(<ThemeToggle />)

      fireEvent.click(screen.getByRole('radio', { name: 'System theme' }))

      expect(mockSetTheme).toHaveBeenCalledWith('system')
    })
  })

  describe('deselection prevention', () => {
    /**
     * This test verifies the fix for a bug where rapidly clicking themes would crash the app.
     *
     * Root cause: Radix UI's ToggleGroup with type="single" allows deselection - clicking
     * the currently active item emits an empty string "" to onValueChange. This empty string
     * would flow through to theme-provider.tsx where root.classList.add("") throws a
     * DOMException because classList doesn't accept empty tokens.
     *
     * The fix adds a guard: if (!value) return
     */
    it('does not call setTheme when clicking the already-selected theme (deselection attempt)', () => {
      mockTheme = 'dark'
      render(<ThemeToggle />)

      // Click the already-selected "dark" option - this triggers Radix's deselection
      // which calls onValueChange with an empty string
      fireEvent.click(screen.getByRole('radio', { name: 'Dark mode' }))

      // setTheme should NOT be called because the guard prevents empty values
      expect(mockSetTheme).not.toHaveBeenCalled()
    })

    it('does not call setTheme with empty string on rapid clicking', () => {
      mockTheme = 'light'
      render(<ThemeToggle />)

      // Simulate rapid clicking that could trigger deselection
      const lightButton = screen.getByRole('radio', { name: 'Light mode' })

      fireEvent.click(lightButton)
      fireEvent.click(lightButton)
      fireEvent.click(lightButton)

      // None of these clicks should have called setTheme since light is already selected
      expect(mockSetTheme).not.toHaveBeenCalled()
    })
  })
})
