/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { LogoutModal } from './logout-modal'

const mockSignOutAndWipe = mock(async ({ onComplete }: { signOut?: () => Promise<void>; onComplete: () => void }) => {
  onComplete()
})

const mockReplace = mock()
const mockReload = mock()
// `reload` must be on the top-level stub so the consumer-mode signOut path
// (which calls `window.location.reload()` from `onComplete`) doesn't blow up
// in tests that don't install their own reload mock. Earlier the consumer-mode
// test below added it ad-hoc, which made other tests order-dependent.
Object.defineProperty(window, 'location', {
  value: { replace: mockReplace, reload: mockReload },
  writable: true,
  configurable: true,
})

describe('LogoutModal', () => {
  let consoleSpies: ConsoleSpies
  let mockOnOpenChange: ReturnType<typeof mock>
  let mockSignOut: ReturnType<typeof mock>

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()
    await setupTestDatabase()
  })

  afterAll(async () => {
    consoleSpies.restore()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockOnOpenChange = mock()
    mockSignOut = mock(() => Promise.resolve())
    mockSignOutAndWipe.mockClear()
    mockReplace.mockClear()
    mockReload.mockClear()
  })

  afterEach(() => {
    mockOnOpenChange.mockClear()
  })

  const renderModal = (props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {}) => {
    const authClient = createMockAuthClient({
      signOut: mockSignOut,
    })
    return render(
      <LogoutModal open={true} onOpenChange={mockOnOpenChange} signOutAndWipe={mockSignOutAndWipe} {...props} />,
      {
        wrapper: createTestProvider({ authClient }),
      },
    )
  }

  describe('rendering', () => {
    it('renders title and wipe-warning description when open', () => {
      renderModal({ open: true })
      expect(screen.getByRole('heading', { name: 'Log out' })).toBeInTheDocument()
      expect(
        screen.getByText('Signing out will remove all chats, settings, and cached data from this device.'),
      ).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByText('Log out')).not.toBeInTheDocument()
    })

    it('displays cancel and logout buttons', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
    })

    it('does not offer a "keep my data" affordance', () => {
      renderModal()
      expect(screen.queryByText(/keep data/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/leave data/i)).not.toBeInTheDocument()
    })

    it('styles the logout button as destructive', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Log out' }).className).toContain('destructive')
    })
  })

  describe('logout flow', () => {
    it('passes the Better Auth signOut callback and an SSO-aware onComplete to signOutAndWipe', async () => {
      const env = import.meta.env as Record<string, string | undefined>
      env.VITE_AUTH_MODE = 'sso'
      try {
        renderModal()
        fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

        await act(async () => {
          await getClock().runAllAsync()
        })

        expect(mockSignOutAndWipe).toHaveBeenCalledTimes(1)
        const arg = mockSignOutAndWipe.mock.calls[0][0]
        expect(typeof arg.signOut).toBe('function')
        await arg.signOut?.()
        expect(mockSignOut).toHaveBeenCalled()
        // SSO mode → onComplete lands on /signed-out via replace().
        expect(mockReplace).toHaveBeenCalledWith('/signed-out')
      } finally {
        delete env.VITE_AUTH_MODE
      }
    })

    it('reloads instead of redirecting in consumer mode', async () => {
      // Default test env has no VITE_AUTH_MODE set → isSsoMode() === false.
      // `mockReload` is installed at module top-level so this test inherits it.
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReload).toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()
    })
  })

  describe('double-click guard', () => {
    it('only fires signOutAndWipe once when Log out is clicked rapidly', () => {
      renderModal()
      const button = screen.getByRole('button', { name: 'Log out' })
      fireEvent.click(button)
      fireEvent.click(button)
      fireEvent.click(button)
      expect(mockSignOutAndWipe).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel behavior', () => {
    it('closes the dialog when cancel is clicked', () => {
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(mockOnOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
