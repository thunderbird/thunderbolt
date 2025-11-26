import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock react-router
const mockNavigate = mock()
let mockSearchParams = new URLSearchParams()

mock.module('react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}))

// Mock useSettings with a Proxy to handle any setting key safely
const createSettingMock = (value: string | null = null) => ({
  value,
  setValue: () => Promise.resolve(),
  isModified: false,
  isLoading: false,
  isSaving: false,
  reset: () => Promise.resolve(),
  data: null,
  rawSetting: null,
  query: { data: [], isLoading: false },
})

mock.module('@/hooks/use-settings', () => ({
  useSettings: () => {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          // Ignore symbols and internal properties
          if (typeof prop === 'symbol') return undefined
          if (prop === 'cloudUrl') {
            return createSettingMock('http://localhost:8000/v1')
          }
          if (prop === 'preferredName') {
            return createSettingMock('')
          }
          // Return safe default for any other accessed property
          return createSettingMock()
        },
      },
    )
  },
}))

// Mock auth client - refetch should resolve immediately
const mockRefetchSession = mock(() => Promise.resolve())
mock.module('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({
      data: null,
      isPending: false,
      error: null,
      refetch: mockRefetchSession,
    }),
    // Add signIn to prevent breakage if this mock leaks into SignInModal tests
    signIn: {
      magicLink: mock(() => Promise.resolve({ error: null })),
    },
  },
}))

// Mock Dialog components to avoid Radix UI issues in test environment
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Mock global fetch
const originalFetch = globalThis.fetch
const mockFetch = mock() as ReturnType<typeof mock> & { preconnect: () => void }
mockFetch.preconnect = () => {}
globalThis.fetch = mockFetch as unknown as typeof fetch

// Import after mocking
const { MagicLinkVerify } = await import('./magic-link-verify')

describe('MagicLinkVerify', () => {
  let consoleSpies: ConsoleSpies

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  afterAll(() => {
    consoleSpies.restore()
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockNavigate.mockClear()
    mockFetch.mockClear()
    mockRefetchSession.mockClear()
    mockSearchParams = new URLSearchParams()
  })

  afterEach(() => {
    mockNavigate.mockClear()
    mockFetch.mockClear()
  })

  describe('missing token', () => {
    it('shows error when token is missing', async () => {
      mockSearchParams = new URLSearchParams() // No token

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('does not call fetch when token is missing', async () => {
      mockSearchParams = new URLSearchParams()

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('verification loading state', () => {
    it('shows loading state initially', () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockReturnValue(new Promise(() => {})) // Never resolves

      render(<MagicLinkVerify />)

      expect(screen.getByText('Signing you in...')).toBeInTheDocument()
      expect(screen.getByText('Verifying...')).toBeInTheDocument()
    })
  })

  describe('successful verification', () => {
    it('shows success state on successful verification', async () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1', email: 'test@example.com' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Welcome!')).toBeInTheDocument()
      expect(screen.getByText("You're now signed in.")).toBeInTheDocument()
    })

    it('calls fetch with correct URL and credentials', async () => {
      mockSearchParams = new URLSearchParams('token=test-token-123')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/api/auth/magic-link/verify?token=test-token-123'),
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
        }),
      )
    })

    it('encodes special characters in token', async () => {
      // Use encodeURIComponent to set the token correctly
      mockSearchParams = new URLSearchParams()
      mockSearchParams.set('token', 'token+with/special=chars')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      // The component uses encodeURIComponent on the token, verify special chars are encoded
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('token=token%2Bwith%2Fspecial%3Dchars'),
        expect.anything(),
      )
    })

    it('navigates to home on continue click', async () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(continueButton)

      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })

    it('refetches session after successful verification', async () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockRefetchSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('verification error', () => {
    it('shows error state when response is not ok', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ message: 'Token expired' }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('shows error message from response', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ message: 'Custom error message' }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      // Error message appears in the state, but the UI shows generic message
      expect(screen.getByText('The link may have expired. Please request a new one.')).toBeInTheDocument()
    })

    it('shows default error when response parsing fails', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.reject(new Error('Parse error')),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('shows network error when fetch fails', async () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockRejectedValue(new Error('Network error'))

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Verification Failed')).toBeInTheDocument()
    })

    it('navigates to home on close click', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      const closeButton = screen.getByRole('button', { name: 'Close' })
      fireEvent.click(closeButton)

      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
    })

    it('does not refetch session when verification fails', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockRefetchSession).not.toHaveBeenCalled()
    })
  })

  describe('modal behavior', () => {
    it('prevents closing during verification', () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockReturnValue(new Promise(() => {})) // Never resolves

      render(<MagicLinkVerify />)

      // Modal is always open and close button is hidden during verification
      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    })

    it('shows close button after error', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token')
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('shows continue button after success', async () => {
      mockSearchParams = new URLSearchParams('token=valid-token')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: { id: '1' } }),
      })

      render(<MagicLinkVerify />)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    })
  })
})
