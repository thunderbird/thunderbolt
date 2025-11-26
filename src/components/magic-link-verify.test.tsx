import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MagicLinkVerify } from './magic-link-verify'

// Mock React Router
const mockSearchParams = new URLSearchParams()
const mockNavigate = mock()

mock.module('react-router', () => ({
  useSearchParams: () => [mockSearchParams],
  useNavigate: () => mockNavigate,
}))

describe('MagicLinkVerify', () => {
  let consoleSpies: ConsoleSpies
  let mockRefetchSession: ReturnType<typeof mock>

  beforeAll(async () => {
    await setupTestDatabase()
    consoleSpies = setupConsoleSpy()
  })

  afterAll(async () => {
    await teardownTestDatabase()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockNavigate.mockClear()
    mockRefetchSession = mock(() => Promise.resolve({ data: null, error: null }))
    mockSearchParams.delete('token')

    // Mock fetch for verification - default to success
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  const renderComponent = (token?: string) => {
    if (token) {
      mockSearchParams.set('token', token)
    }
    const authClient = createMockAuthClient({
      session: null,
      isPending: false,
    })
    // Override useSession to use our mock refetch
    authClient.useSession = () =>
      ({
        data: null,
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: mockRefetchSession,
      }) as ReturnType<typeof authClient.useSession>
    return render(<MagicLinkVerify />, {
      wrapper: createTestProvider({ authClient }),
    })
  }

  // Helper to wait for state changes
  const waitForStateChange = async () => {
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  describe('missing token', () => {
    it('shows error when token is missing', async () => {
      renderComponent()
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(screen.getByText('The link may have expired. Please request a new one.')).toBeInTheDocument()
    })

    it('does not call fetch when token is missing', async () => {
      renderComponent()
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  describe('verification loading state', () => {
    it('shows loading state initially', () => {
      // Set up a fetch that never resolves to keep loading state
      globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch

      renderComponent('valid-token')

      expect(screen.getByText('Verifying...')).toBeInTheDocument()
    })
  })

  describe('successful verification', () => {
    it('shows success state on successful verification', async () => {
      renderComponent('valid-token')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()
    })

    it('calls fetch with correct URL and credentials', async () => {
      renderComponent('valid-token')
      await waitForStateChange()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/magic-link/verify?token=valid-token'),
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
        }),
      )
    })

    it('encodes special characters in token', async () => {
      renderComponent('token+with/special=chars')
      await waitForStateChange()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('token%2Bwith%2Fspecial%3Dchars'),
        expect.anything(),
      )
    })

    it('navigates to home on continue click', async () => {
      renderComponent('valid-token')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(continueButton)

      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })

    it('refetches session after successful verification', async () => {
      renderComponent('valid-token')
      await waitForStateChange()

      expect(screen.getByText('Welcome!')).toBeInTheDocument()
      expect(mockRefetchSession).toHaveBeenCalled()
    })
  })

  describe('verification error', () => {
    it('shows error state when response is not ok', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Invalid token' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ) as unknown as typeof fetch

      renderComponent('invalid-token')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('shows error when fetch fails', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as unknown as typeof fetch

      renderComponent('any-token')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('navigates to home on close click', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Invalid' }), {
            status: 400,
          }),
        ),
      ) as unknown as typeof fetch

      renderComponent('invalid-token')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()

      const closeButton = screen.getByRole('button', { name: 'Close' })
      fireEvent.click(closeButton)

      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })

    it('does not refetch session when verification fails', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Invalid' }), {
            status: 400,
          }),
        ),
      ) as unknown as typeof fetch

      renderComponent('invalid-token')
      await waitForStateChange()

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
      expect(mockRefetchSession).not.toHaveBeenCalled()
    })
  })

  describe('modal behavior', () => {
    it('shows verifying text during verification', () => {
      globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch

      renderComponent('token')

      expect(screen.getByText('Verifying...')).toBeInTheDocument()
    })

    it('shows close button after error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Invalid' }), {
            status: 400,
          }),
        ),
      ) as unknown as typeof fetch

      renderComponent('invalid-token')
      await waitForStateChange()

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('shows continue button after success', async () => {
      renderComponent('valid-token')
      await waitForStateChange()

      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    })
  })
})
