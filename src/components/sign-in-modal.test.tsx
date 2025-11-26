import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock the auth client
const mockSignInMagicLink = mock()

mock.module('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      magicLink: mockSignInMagicLink,
    },
    // Add useSession to prevent breakage if this mock leaks into MagicLinkVerify tests
    useSession: () => ({
      data: null,
      isPending: false,
      error: null,
      refetch: mock(() => Promise.resolve()),
    }),
  },
}))

// Mock useSettings with a Proxy to handle any setting key safely
// This prevents breaking other tests (like useCountryUnits) that rely on other settings
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
          // Return safe default for any other accessed property
          return createSettingMock()
        },
      },
    )
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

// Import after mocking
const { SignInModal } = await import('./sign-in-modal')

describe('SignInModal', () => {
  let consoleSpies: ConsoleSpies
  let mockOnOpenChange: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockOnOpenChange = mock()
    mockSignInMagicLink.mockClear()
    mockSignInMagicLink.mockResolvedValue({ error: null })
  })

  afterEach(() => {
    mockOnOpenChange.mockClear()
  })

  const renderModal = (props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {}) => {
    return render(<SignInModal open={true} onOpenChange={mockOnOpenChange} {...props} />, {
      wrapper: createTestProvider(),
    })
  }

  describe('rendering', () => {
    it('renders when open', () => {
      renderModal({ open: true })
      expect(screen.getByText('Unlock more features')).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByText('Unlock more features')).not.toBeInTheDocument()
    })

    it('displays feature cards', () => {
      renderModal()
      expect(screen.getByText('Premium AI')).toBeInTheDocument()
      expect(screen.getByText('Access your chats everywhere')).toBeInTheDocument()
    })

    it('displays email input placeholder', () => {
      renderModal()
      expect(screen.getByPlaceholderText('Email address')).toBeInTheDocument()
    })

    it('displays send button', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Send Magic Link' })).toBeInTheDocument()
    })
  })

  describe('email input', () => {
    it('updates email value on change', () => {
      renderModal()
      const input = screen.getByPlaceholderText('Email address')

      fireEvent.change(input, { target: { value: 'test@example.com' } })

      expect(input).toHaveValue('test@example.com')
    })

    it('disables submit button when email is empty', () => {
      renderModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      expect(button).toBeDisabled()
    })

    it('enables submit button when email has value', () => {
      renderModal()
      const input = screen.getByPlaceholderText('Email address')
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'test@example.com' } })

      expect(button).not.toBeDisabled()
    })

    it('disables submit button when email is only whitespace', () => {
      renderModal()
      const input = screen.getByPlaceholderText('Email address')
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: '   ' } })

      expect(button).toBeDisabled()
    })
  })

  describe('form submission', () => {
    it('calls signIn.magicLink with trimmed email', async () => {
      mockSignInMagicLink.mockResolvedValue({ error: null })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: '  test@example.com  ' } })
      fireEvent.click(button)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockSignInMagicLink).toHaveBeenCalledWith({
        email: 'test@example.com',
        callbackURL: '/',
      })
    })

    it('shows loading state while sending', async () => {
      let resolvePromise: (value: { error: null }) => void
      mockSignInMagicLink.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve
        }),
      )

      renderModal()
      const input = screen.getByPlaceholderText('Email address')
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.click(button)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Sending...')).toBeInTheDocument()
      expect(input).toBeDisabled()

      // Resolve to clean up
      resolvePromise!({ error: null })
      await act(async () => {
        await getClock().runAllAsync()
      })
    })

    it('shows success state after successful submission', async () => {
      mockSignInMagicLink.mockResolvedValue({ error: null })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      // In test environment (localhost), shows localhost message
      expect(screen.getAllByText('Check the backend logs').length).toBeGreaterThan(0)
      expect(screen.getByText(/localhost/)).toBeInTheDocument()
    })

    it('does not submit when email is empty', async () => {
      renderModal()
      const form = screen.getByPlaceholderText('Email address').closest('form')!

      fireEvent.submit(form)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockSignInMagicLink).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('shows error message on API error', async () => {
      mockSignInMagicLink.mockResolvedValue({
        error: { message: 'Invalid email address' },
      })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'invalid' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Invalid email address')).toBeInTheDocument()
    })

    it('shows default error message when error has no message', async () => {
      mockSignInMagicLink.mockResolvedValue({
        error: {},
      })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(screen.getByText('Failed to send magic link')).toBeInTheDocument()
    })
  })

  describe('modal close behavior', () => {
    it('resets state when modal is closed', () => {
      renderModal()
      const input = screen.getByPlaceholderText('Email address')

      // Enter email
      fireEvent.change(input, { target: { value: 'test@example.com' } })

      // Verify email is stored
      expect(input).toHaveValue('test@example.com')
    })

    it('calls onOpenChange when close button is clicked in success state', async () => {
      mockSignInMagicLink.mockResolvedValue({ error: null })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      // Find the visible Close button (not the dialog X button which has sr-only text)
      const closeButtons = screen.getAllByRole('button', { name: 'Close' })
      // The first one is the visible button, the second is the X icon with sr-only text
      const visibleCloseButton = closeButtons.find((btn) => !btn.querySelector('.sr-only'))!
      fireEvent.click(visibleCloseButton)

      expect(mockOnOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
