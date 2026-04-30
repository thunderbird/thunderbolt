/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { AccountDeleted } from './account-deleted'

const mockReplace = mock()
Object.defineProperty(window, 'location', {
  value: { replace: mockReplace },
  writable: true,
})

describe('AccountDeleted', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    mockReplace.mockClear()
  })

  const renderComponent = () =>
    render(<AccountDeleted />, {
      wrapper: createTestProvider(),
    })

  describe('rendering', () => {
    it('renders heading and description', () => {
      renderComponent()
      expect(screen.getByRole('heading', { name: 'Account Deleted' })).toBeInTheDocument()
      expect(screen.getByText('Your account has been deleted and local data has been cleared.')).toBeInTheDocument()
    })

    it('renders Thunderbolt branding', () => {
      renderComponent()
      expect(screen.getByText('Thunderbolt')).toBeInTheDocument()
    })

    it('renders Back to App button', () => {
      renderComponent()
      expect(screen.getByRole('button', { name: 'Back to App' })).toBeInTheDocument()
    })
  })

  describe('Back to App button', () => {
    it('calls window.location.replace("/") when clicked', () => {
      renderComponent()
      fireEvent.click(screen.getByRole('button', { name: 'Back to App' }))
      expect(mockReplace).toHaveBeenCalledWith('/')
    })
  })
})
