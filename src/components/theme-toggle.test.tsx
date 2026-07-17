/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { ThemeToggle } from './theme-toggle'

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

  it('labels the button with the action it performs', () => {
    mockTheme = 'dark'
    render(<ThemeToggle />)

    expect(screen.getByRole('button', { name: 'Switch to system theme' })).toBeInTheDocument()
  })

  it('cycles light → dark', () => {
    mockTheme = 'light'
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))

    expect(mockSetTheme).toHaveBeenCalledWith('dark')
  })

  it('cycles dark → system', () => {
    mockTheme = 'dark'
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to system theme' }))

    expect(mockSetTheme).toHaveBeenCalledWith('system')
  })

  it('cycles system → light', () => {
    mockTheme = 'system'
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))

    expect(mockSetTheme).toHaveBeenCalledWith('light')
  })
})
