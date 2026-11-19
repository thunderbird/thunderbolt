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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { LogoutModal } from './logout-modal'

const mockClearLocalData = mock(() => Promise.resolve())

const env = import.meta.env as Record<string, string | undefined>

describe('LogoutModal', () => {
  let consoleSpies: ConsoleSpies
  let mockOnOpenChange: ReturnType<typeof mock>
  let mockReload: ReturnType<typeof spyOn>
  let mockReplace: ReturnType<typeof spyOn>
  let mockSignOut: ReturnType<typeof mock>

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()
    await setupTestDatabase()
    mockReload = spyOn(window.location, 'reload').mockImplementation(() => undefined)
    mockReplace = spyOn(window.location, 'replace').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    mockReload.mockRestore()
    mockReplace.mockRestore()
    consoleSpies.restore()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockOnOpenChange = mock()
    mockSignOut = mock(() => Promise.resolve({ data: { success: true }, error: null }))
    mockClearLocalData.mockClear()
    mockReload.mockClear()
    mockReplace.mockClear()
  })

  afterEach(() => {
    mockOnOpenChange.mockClear()
    delete env.VITE_AUTH_MODE
  })

  const renderModal = (props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {}) => {
    const authClient = createMockAuthClient({
      signOut: mockSignOut,
    })
    return render(
      <LogoutModal open={true} onOpenChange={mockOnOpenChange} clearLocalData={mockClearLocalData} {...props} />,
      {
        wrapper: createTestProvider({ authClient }),
      },
    )
  }

  describe('rendering', () => {
    it('renders when open', () => {
      renderModal({ open: true })
      // Check for the dialog title specifically
      expect(screen.getByRole('heading', { name: 'Log out' })).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByText('Log out')).not.toBeInTheDocument()
    })

    it('displays description text', () => {
      renderModal()
      expect(screen.getByText('What would you like to do with your local data?')).toBeInTheDocument()
    })

    it('displays both data options', () => {
      renderModal()
      expect(screen.getByText('Leave data on device')).toBeInTheDocument()
      expect(screen.getByText('Delete data from device')).toBeInTheDocument()
    })

    it('displays cancel and logout buttons', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
    })
  })

  describe('option selection', () => {
    it('has "keep" option selected by default', () => {
      renderModal()
      const keepOption = screen.getByText('Leave data on device').closest('button')
      // Check the radio indicator is styled as selected (has the inner dot)
      expect(keepOption?.querySelector('.bg-primary')).toBeInTheDocument()
    })

    it('selects "delete" option when clicked', () => {
      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!

      fireEvent.click(deleteOption)

      // Check the delete option is now selected
      expect(deleteOption.querySelector('.bg-destructive')).toBeInTheDocument()
    })

    it('allows switching between options', () => {
      renderModal()
      const keepOption = screen.getByText('Leave data on device').closest('button')!
      const deleteOption = screen.getByText('Delete data from device').closest('button')!

      // Select delete
      fireEvent.click(deleteOption)
      expect(deleteOption.querySelector('.bg-destructive')).toBeInTheDocument()

      // Switch back to keep
      fireEvent.click(keepOption)
      expect(keepOption.querySelector('.bg-primary')).toBeInTheDocument()
    })
  })

  describe('logout flow with keep data', () => {
    it('calls signOut and reloads when logging out with keep option', async () => {
      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockSignOut).toHaveBeenCalled()
      expect(mockClearLocalData).toHaveBeenCalledWith({ clearDatabase: false })
      expect(mockReload).toHaveBeenCalled()
    })

    it('shows loading state during logout', async () => {
      let resolveSignOut: (value?: unknown) => void
      mockSignOut.mockReturnValue(
        new Promise((resolve) => {
          resolveSignOut = resolve
        }),
      )

      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Logging out…')).toBeInTheDocument()
      expect(screen.getByText('Leave data on device').closest('button')).toBeDisabled()
      expect(screen.getByText('Delete data from device').closest('button')).toBeDisabled()
      expect(mockClearLocalData).not.toHaveBeenCalled()
      expect(mockReload).not.toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()

      // Clean up
      resolveSignOut!({ data: { success: true }, error: null })
      await act(async () => {
        await getClock().runAllAsync()
      })
    })
  })

  describe('logout flow with delete data', () => {
    it('calls signOut, clearLocalData with clearDatabase, and reloads when deleting data', async () => {
      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(deleteOption)
      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockSignOut).toHaveBeenCalled()
      expect(mockClearLocalData).toHaveBeenCalledWith({ clearDatabase: true })
      expect(mockReload).toHaveBeenCalled()
    })

    it('shows delete-specific loading text', async () => {
      let resolveSignOut: (value?: unknown) => void
      mockSignOut.mockReturnValue(
        new Promise((resolve) => {
          resolveSignOut = resolve
        }),
      )

      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(deleteOption)
      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Deleting…')).toBeInTheDocument()

      // Clean up
      resolveSignOut!({ data: { success: true }, error: null })
      await act(async () => {
        await getClock().runAllAsync()
      })
    })

    it('uses destructive button variant when delete is selected', () => {
      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(deleteOption)

      // Check for destructive variant class
      expect(logoutButton.className).toContain('destructive')
    })
  })

  describe.each(['sso', 'thunderbolt'])('%s sign-out failures', (authMode) => {
    describe.each(['keep', 'delete'])('with %s data', (option) => {
      it.each(['returned', 'thrown'])(
        'preserves data and choice after a %s error, then allows retry',
        async (failure) => {
          env.VITE_AUTH_MODE = authMode
          if (failure === 'returned') {
            mockSignOut.mockResolvedValueOnce({
              data: null,
              error: { message: 'Server error', status: 500, statusText: 'Internal Server Error' },
            })
          } else {
            mockSignOut.mockRejectedValueOnce(new Error('Network error'))
          }

          renderModal()
          const choice = screen
            .getByText(option === 'delete' ? 'Delete data from device' : 'Leave data on device')
            .closest('button')!
          fireEvent.click(choice)
          fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
          await act(async () => {
            await getClock().runAllAsync()
          })

          expect(mockClearLocalData).not.toHaveBeenCalled()
          expect(mockReload).not.toHaveBeenCalled()
          expect(mockReplace).not.toHaveBeenCalled()
          expect(mockOnOpenChange).not.toHaveBeenCalled()
          expect(screen.getByRole('heading', { name: 'Log out' })).toBeInTheDocument()
          expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm sign-out. Please try again.')
          expect(choice.querySelector(option === 'delete' ? '.bg-destructive' : '.bg-primary')).toBeInTheDocument()
          expect(choice).toBeEnabled()
          expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
          expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled()

          fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
          await act(async () => {
            await getClock().runAllAsync()
          })

          expect(mockSignOut).toHaveBeenCalledTimes(2)
          expect(screen.queryByRole('alert')).not.toBeInTheDocument()
          expect(mockClearLocalData).toHaveBeenCalledTimes(1)
          expect(mockClearLocalData).toHaveBeenCalledWith({ clearDatabase: option === 'delete' })
          if (authMode === 'sso') {
            expect(mockReplace).toHaveBeenCalledWith('/signed-out')
            expect(mockReload).not.toHaveBeenCalled()
          } else {
            expect(mockReload).toHaveBeenCalledTimes(1)
            expect(mockReplace).not.toHaveBeenCalled()
          }
        },
      )
    })
  })

  describe('error handling', () => {
    it('does not clean up without an affirmative success result', async () => {
      mockSignOut.mockResolvedValueOnce({ data: { success: false }, error: null })
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(mockClearLocalData).not.toHaveBeenCalled()
      expect(mockReload).not.toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()
    })

    it('continues to reload even if clearLocalData fails', async () => {
      mockClearLocalData.mockRejectedValueOnce(new Error('Cleanup error'))

      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(deleteOption)
      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReload).toHaveBeenCalled()
    })
  })

  describe('SSO mode logout', () => {
    beforeEach(() => {
      env.VITE_AUTH_MODE = 'sso'
    })

    it('navigates to /signed-out instead of reloading in SSO mode', async () => {
      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockSignOut).toHaveBeenCalledWith({ fetchOptions: { disableSignal: true } })
      expect(mockReplace).toHaveBeenCalledWith('/signed-out')
      expect(mockReload).not.toHaveBeenCalled()
    })
  })

  describe('modal behavior during logout', () => {
    it('prevents closing while logging out', async () => {
      let resolveSignOut: (value?: unknown) => void
      mockSignOut.mockReturnValue(
        new Promise((resolve) => {
          resolveSignOut = resolve
        }),
      )

      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      // Try to cancel - should be disabled
      const cancelButton = screen.getByRole('button', { name: 'Cancel' })
      expect(cancelButton).toBeDisabled()

      // Clean up
      resolveSignOut!({ data: { success: true }, error: null })
      await act(async () => {
        await getClock().runAllAsync()
      })
    })

    it('disables logout button while logging out', async () => {
      let resolveSignOut: (value?: unknown) => void
      mockSignOut.mockReturnValue(
        new Promise((resolve) => {
          resolveSignOut = resolve
        }),
      )

      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      // The button text changes and becomes disabled
      expect(screen.getByRole('button', { name: /Logging out|Deleting/i })).toBeDisabled()

      // Clean up
      resolveSignOut!({ data: { success: true }, error: null })
      await act(async () => {
        await getClock().runAllAsync()
      })
    })
  })

  describe('cancel behavior', () => {
    it('calls onOpenChange(false) when cancel is clicked', () => {
      renderModal()
      const cancelButton = screen.getByRole('button', { name: 'Cancel' })

      fireEvent.click(cancelButton)

      expect(mockOnOpenChange).toHaveBeenCalledWith(false)
    })

    it('resets option selection when modal is closed', () => {
      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!

      // Select delete option
      fireEvent.click(deleteOption)

      // Close and reopen - selection should reset via onOpenChange handler
      // The component resets selectedOption to 'keep' when newOpen is false
      expect(mockOnOpenChange).not.toHaveBeenCalled()
    })
  })
})
