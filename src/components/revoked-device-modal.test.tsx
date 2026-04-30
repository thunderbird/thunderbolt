/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { RevokedDeviceModal } from './revoked-device-modal'

const mockClearLocalData = mock(() => Promise.resolve())
mock.module('@/lib/cleanup', () => ({
  clearLocalData: mockClearLocalData,
}))

const mockReplace = mock()
Object.defineProperty(window, 'location', {
  value: { replace: mockReplace },
  writable: true,
})

describe('RevokedDeviceModal', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockClearLocalData.mockClear()
    mockReplace.mockClear()
  })

  const renderModal = (props: Partial<{ open: boolean }> = {}) =>
    render(<RevokedDeviceModal open={props.open ?? true} />, {
      wrapper: createTestProvider(),
    })

  describe('rendering', () => {
    it('renders when open', () => {
      renderModal({ open: true })
      expect(screen.getByRole('heading', { name: 'Device access revoked' })).toBeInTheDocument()
      expect(
        screen.getByText('This device has been signed out remotely. Choose what to do with your local data.'),
      ).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByRole('heading', { name: 'Device access revoked' })).not.toBeInTheDocument()
    })

    it('displays both data options', () => {
      renderModal()
      expect(screen.getByText('Keep data on device')).toBeInTheDocument()
      expect(screen.getByText('Delete data from device')).toBeInTheDocument()
    })

    it('displays confirm button', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    })

    it('does not show close button', () => {
      renderModal()
      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    })
  })

  describe('option selection', () => {
    it('has "keep" option selected by default', () => {
      renderModal()
      const keepOption = screen.getByText('Keep data on device').closest('button')
      expect(keepOption?.querySelector('.bg-primary')).toBeInTheDocument()
    })

    it('selects "delete" option when clicked', () => {
      renderModal()
      const deleteOption = screen.getByText('Delete data from device').closest('button')!
      fireEvent.click(deleteOption)
      expect(deleteOption.querySelector('.bg-destructive')).toBeInTheDocument()
    })

    it('allows switching between options', () => {
      renderModal()
      const keepOption = screen.getByText('Keep data on device').closest('button')!
      const deleteOption = screen.getByText('Delete data from device').closest('button')!

      fireEvent.click(deleteOption)
      expect(deleteOption.querySelector('.bg-destructive')).toBeInTheDocument()

      fireEvent.click(keepOption)
      expect(keepOption.querySelector('.bg-primary')).toBeInTheDocument()
    })
  })

  describe('confirm flow with keep data', () => {
    it('calls window.location.replace("/") when confirming with keep option', async () => {
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockClearLocalData).toHaveBeenCalledWith({ clearDatabase: false })
      expect(mockReplace).toHaveBeenCalledWith('/')
    })

    it('shows loading state during confirm', async () => {
      renderModal()
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Signing out...')).toBeInTheDocument()

      await act(async () => {
        await getClock().runAllAsync()
      })
    })
  })

  describe('confirm flow with delete data', () => {
    it('calls clearLocalData with clearDatabase and window.location.replace when confirming with delete option', async () => {
      renderModal()
      fireEvent.click(screen.getByText('Delete data from device').closest('button')!)
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockClearLocalData).toHaveBeenCalledWith({ clearDatabase: true })
      expect(mockReplace).toHaveBeenCalledWith('/')
    })

    it('shows delete-specific loading text', async () => {
      renderModal()
      fireEvent.click(screen.getByText('Delete data from device').closest('button')!)
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Deleting...')).toBeInTheDocument()

      await act(async () => {
        await getClock().runAllAsync()
      })
    })

    it('uses destructive button variant when delete is selected', () => {
      renderModal()
      fireEvent.click(screen.getByText('Delete data from device').closest('button')!)
      const confirmButton = screen.getByRole('button', { name: 'Confirm' })
      expect(confirmButton.className).toContain('destructive')
    })
  })
})
