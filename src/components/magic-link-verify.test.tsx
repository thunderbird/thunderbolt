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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { MagicLinkVerify } from './magic-link-verify'

/**
 * Spy component that tracks navigation. When the component calls navigate('/', { replace: true }),
 * the location changes — we observe it here.
 */
const NavigationSpy = ({ onLocationChange }: { onLocationChange: (pathname: string) => void }) => {
  const location = useLocation()
  onLocationChange(location.pathname)
  return null
}

describe('MagicLinkVerify', () => {
  let consoleSpies: ConsoleSpies
  let mockRefetchSession: ReturnType<typeof mock>
  let mockSignInEmailOtp: ReturnType<typeof mock>

  beforeAll(async () => {
    await setupTestDatabase()
    consoleSpies = setupConsoleSpy()
  })

  afterAll(async () => {
    await teardownTestDatabase()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockRefetchSession = mock(() => Promise.resolve({ data: null, error: null }))
    mockSignInEmailOtp = mock(() => Promise.resolve({ error: null }))
  })

  afterEach(async () => {
    await resetTestDatabase()
    cleanup()
  })

  const renderComponent = (email?: string, otp?: string) => {
    const params = new URLSearchParams()
    if (email) {
      params.set('email', email)
    }
    if (otp) {
      params.set('otp', otp)
    }
    const url = `/verify${params.toString() ? `?${params.toString()}` : ''}`

    const authClient = createMockAuthClient({
      session: null,
      isPending: false,
      signInEmailOtp: mockSignInEmailOtp,
    })
    authClient.useSession = () =>
      ({
        data: null,
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: mockRefetchSession,
      }) as ReturnType<typeof authClient.useSession>

    let lastPathname = '/verify'
    const TestProvider = createTestProvider({ authClient })

    const result = render(
      <>
        <MagicLinkVerify />
        <NavigationSpy
          onLocationChange={(p) => {
            lastPathname = p
          }}
        />
      </>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MemoryRouter initialEntries={[url]}>
            <TestProvider>{children}</TestProvider>
          </MemoryRouter>
        ),
      },
    )

    return { ...result, getLastPathname: () => lastPathname }
  }

  const waitForStateChange = async () => {
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  describe('missing parameters', () => {
    it('shows error when email is missing', async () => {
      renderComponent(undefined, '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('Invalid verification link. Please request a new one.')).toBeInTheDocument()
    })

    it('shows error when otp is missing', async () => {
      renderComponent('user@example.com', undefined)
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('shows error when both params are missing', async () => {
      renderComponent()
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('does not call signIn.emailOtp when params are missing', async () => {
      renderComponent()
      await waitForStateChange()

      expect(mockSignInEmailOtp).not.toHaveBeenCalled()
    })
  })

  describe('verification loading state', () => {
    it('shows loading state initially', () => {
      mockSignInEmailOtp.mockReturnValue(new Promise(() => {}))

      renderComponent('user@example.com', '123456')

      expect(screen.getByText('Signing you in...')).toBeInTheDocument()
    })
  })

  describe('successful verification', () => {
    it('shows success state on successful verification', async () => {
      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()
    })

    it('calls signIn.emailOtp with email and otp', async () => {
      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(mockSignInEmailOtp).toHaveBeenCalledWith({
        email: 'user@example.com',
        otp: '123456',
      })
    })

    it('navigates to home on continue click', async () => {
      const { getLastPathname } = renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(continueButton)

      expect(getLastPathname()).toBe('/')
    })

    it('refetches session after successful verification', async () => {
      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()
      expect(mockRefetchSession).toHaveBeenCalled()
    })
  })

  describe('verification error', () => {
    it('shows error state when verification fails', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { message: 'Invalid OTP' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('Invalid OTP')).toBeInTheDocument()
    })

    it('shows specific error for TOO_MANY_ATTEMPTS', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('Too many attempts. Please request a new code.')).toBeInTheDocument()
    })

    it('shows specific error for INVALID_OTP', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { code: 'INVALID_OTP', message: 'Invalid OTP' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('This link is invalid. Please request a new one.')).toBeInTheDocument()
    })

    it('shows specific error for OTP_EXPIRED', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { code: 'OTP_EXPIRED', message: 'OTP expired' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('This link has expired. Please request a new one.')).toBeInTheDocument()
    })

    it('shows error when signIn throws', async () => {
      mockSignInEmailOtp.mockRejectedValue(new Error('Network error'))

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })

    it('navigates to home on close click', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { message: 'Invalid' },
      })

      const { getLastPathname } = renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()

      const closeButton = screen.getByRole('button', { name: 'Close' })
      fireEvent.click(closeButton)

      expect(getLastPathname()).toBe('/')
    })

    it('does not refetch session when verification fails', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { message: 'Invalid' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(mockRefetchSession).not.toHaveBeenCalled()
    })
  })

  describe('modal behavior', () => {
    it('shows close button after error', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { message: 'Invalid' },
      })

      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('shows continue button after success', async () => {
      renderComponent('user@example.com', '123456')
      await waitForStateChange()

      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    })
  })
})
