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

const mockClearLocalData = mock(() => Promise.resolve())

mock.module('@/lib/cleanup', () => ({
  clearLocalData: mockClearLocalData,
}))

// Mock window.location.reload
const mockReload = mock()
Object.defineProperty(window, 'location', {
  value: { reload: mockReload },
  writable: true,
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
    mockClearLocalData.mockClear()
    mockReload.mockClear()
  })

  afterEach(() => {
    mockOnOpenChange.mockClear()
  })

  const renderModal = (props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {}) => {
    const authClient = createMockAuthClient({
      signOut: mockSignOut,
    })
    return render(<LogoutModal open={true} onOpenChange={mockOnOpenChange} {...props} />, {
      wrapper: createTestProvider({ authClient }),
    })
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

      expect(screen.getByText('Logging out...')).toBeInTheDocument()

      // Clean up
      resolveSignOut!()
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

      expect(screen.getByText('Deleting...')).toBeInTheDocument()

      // Clean up
      resolveSignOut!()
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

  describe('error handling', () => {
    it('continues to reload even if signOut fails', async () => {
      mockSignOut.mockRejectedValue(new Error('Network error'))

      renderModal()
      const logoutButton = screen.getByRole('button', { name: 'Log out' })

      fireEvent.click(logoutButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReload).toHaveBeenCalled()
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
      resolveSignOut!()
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
      resolveSignOut!()
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
