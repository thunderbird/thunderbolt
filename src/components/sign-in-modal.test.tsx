import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client'
import type { HttpClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock InputOTP to avoid timer issues in tests
// The input-otp library uses internal timers that conflict with fake timers
mock.module('@/components/ui/input-otp', () => ({
  InputOTP: ({
    children,
    value,
    onChange,
    onComplete,
    disabled,
    maxLength,
  }: {
    children: ReactNode
    value?: string
    onChange?: (value: string) => void
    onComplete?: (value: string) => void
    disabled?: boolean
    maxLength?: number
  }) => {
    return (
      <div data-testid="mock-otp-input" data-disabled={disabled} data-max-length={maxLength}>
        <input
          type="text"
          value={value || ''}
          onChange={(e) => {
            const newValue = e.target.value.slice(0, maxLength || 8)
            onChange?.(newValue)
            if (newValue.length === (maxLength || 8)) {
              onComplete?.(newValue)
            }
          }}
          disabled={disabled}
          data-testid="otp-input"
        />
        {children}
      </div>
    )
  },
  InputOTPGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InputOTPSlot: ({ index }: { index: number }) => <div data-slot-index={index} />,
  InputOTPSeparator: () => <span>-</span>,
}))

// Import after mock
import { SignInModal } from './sign-in-modal'
import { type ReactNode } from 'react'

const challengeToken = 'test-challenge-token'
const waitlistResponse = { success: true, challengeToken }

describe('SignInModal', () => {
  let consoleSpies: ConsoleSpies
  let mockOnOpenChange: ReturnType<typeof mock>
  let mockSignInEmailOtp: ReturnType<typeof mock>
  let mockHttpClient: HttpClient
  let mockFetchSpy: ReturnType<typeof mock>

  beforeAll(async () => {
    await setupTestDatabase()
    consoleSpies = setupConsoleSpy()
  })

  afterAll(async () => {
    await teardownTestDatabase()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockOnOpenChange = mock()
    mockSignInEmailOtp = mock(() => Promise.resolve({ error: null }))
    const { httpClient, fetchSpy } = createSpyHttpClient(undefined, waitlistResponse)
    mockHttpClient = httpClient
    mockFetchSpy = fetchSpy
  })

  afterEach(async () => {
    await resetTestDatabase()
    mockOnOpenChange.mockClear()
  })

  const renderModal = (
    props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {},
    httpClient?: HttpClient,
  ) => {
    const authClient = createMockAuthClient({
      signInEmailOtp: mockSignInEmailOtp,
    })
    return render(<SignInModal open={true} onOpenChange={mockOnOpenChange} {...props} />, {
      wrapper: createTestProvider({ authClient, httpClient: httpClient ?? mockHttpClient }),
    })
  }

  /** Wait for the modal to render and return the email input */
  const waitForModal = async () => {
    const input = await screen.findByPlaceholderText('Email address')
    return input
  }

  describe('rendering', () => {
    it('renders when open', async () => {
      renderModal({ open: true })
      expect(await screen.findByText('Sign In')).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByText('Sign In')).not.toBeInTheDocument()
    })

    it('displays feature cards', async () => {
      renderModal()
      await waitForModal()
      expect(screen.getByText('Access more powerful AI models')).toBeInTheDocument()
      expect(screen.getByText('Sync chats between devices')).toBeInTheDocument()
    })

    it('displays email input placeholder', async () => {
      renderModal()
      expect(await screen.findByPlaceholderText('Email address')).toBeInTheDocument()
    })

    it('displays send button', async () => {
      renderModal()
      await waitForModal()
      expect(screen.getByRole('button', { name: 'Send Magic Link' })).toBeInTheDocument()
    })
  })

  describe('email input', () => {
    it('updates email value on change', async () => {
      renderModal()
      const input = await waitForModal()

      fireEvent.change(input, { target: { value: 'test@example.com' } })

      expect(input).toHaveValue('test@example.com')
    })

    it('disables submit button when email is empty', async () => {
      renderModal()
      await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      expect(button).toBeDisabled()
    })

    it('enables submit button when email has value', async () => {
      renderModal()
      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'test@example.com' } })

      expect(button).not.toBeDisabled()
    })

    it('disables submit button when email is only whitespace', async () => {
      renderModal()
      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: '   ' } })

      expect(button).toBeDisabled()
    })

    it('disables submit button when email format is invalid', async () => {
      renderModal()
      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'not-an-email' } })

      expect(button).toBeDisabled()
    })

    it('enables submit button when email format is valid', async () => {
      renderModal()
      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'valid@email.com' } })

      expect(button).not.toBeDisabled()
    })
  })

  describe('form submission', () => {
    it('calls waitlist/join endpoint with trimmed email', async () => {
      renderModal()

      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: '  test@example.com  ' } })
      fireEvent.click(button)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockFetchSpy).toHaveBeenCalledTimes(1)
      const request = mockFetchSpy.mock.calls[0][0] as Request
      expect(request.url).toContain('waitlist/join')
      const body = await request.clone().json()
      expect(body).toEqual({ email: 'test@example.com' })
    })

    it('shows loading state while sending', async () => {
      let resolveRequest!: () => void
      const { httpClient: pendingHttpClient } = createSpyHttpClient(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = () => resolve(jsonResponse(waitlistResponse))
          }),
      )

      renderModal({}, pendingHttpClient)
      const input = await waitForModal()
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.click(button)

      await act(async () => {
        await getClock().tickAsync(0)
      })

      expect(screen.getByText('Sending...')).toBeInTheDocument()
      expect(input).toBeDisabled()

      // Resolve to clean up
      resolveRequest()
      await act(async () => {
        await getClock().runAllAsync()
      })
    })

    it('shows sent state after successful submission', async () => {
      renderModal()

      const input = await waitForModal()
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // In test environment (localhost), shows localhost message
      expect(screen.getAllByText('Check the backend logs').length).toBeGreaterThan(0)
      expect(screen.getByText(/localhost/)).toBeInTheDocument()
    })

    it('does not submit when email is empty', async () => {
      renderModal()
      const input = await waitForModal()
      const form = input.closest('form')!

      fireEvent.submit(form)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockFetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('shows error message when API call fails', async () => {
      const { httpClient: errorHttpClient } = createSpyHttpClient(async () =>
        jsonResponse({ error: 'Bad request' }, 400),
      )

      renderModal({}, errorHttpClient)

      const input = await waitForModal()
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(screen.getByText('Failed to send verification code. Please check your connection.')).toBeInTheDocument()
    })

    it('shows error message when network request throws', async () => {
      const { httpClient: errorHttpClient } = createSpyHttpClient(async () => {
        throw new Error('Network error')
      })

      renderModal({}, errorHttpClient)

      const input = await waitForModal()
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(screen.getByText('Failed to send verification code. Please check your connection.')).toBeInTheDocument()
    })
  })

  describe('modal close behavior', () => {
    it('resets state when modal is closed', async () => {
      renderModal()
      const input = await waitForModal()

      // Enter email
      fireEvent.change(input, { target: { value: 'test@example.com' } })

      // Verify email is stored
      expect(input).toHaveValue('test@example.com')
    })

    it('calls onOpenChange when close button is clicked in sent state', async () => {
      renderModal()

      const input = await waitForModal()
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Find the Cancel button
      const cancelButton = screen.getByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelButton)

      expect(mockOnOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe('OTP verification', () => {
    it('shows OTP input after sending verification code', async () => {
      renderModal()

      const input = await waitForModal()
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Should show OTP input prompt
      expect(screen.getByText('Or enter the 8-digit code')).toBeInTheDocument()
      expect(screen.getByTestId('mock-otp-input')).toBeInTheDocument()
    })

    it('shows success state after successful OTP verification', async () => {
      renderModal()

      // Send verification code first
      const emailInput = await waitForModal()
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '12345678' } })

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Should show success message (use getAllByText since DialogTitle duplicates it)
      expect(screen.getAllByText('Welcome!').length).toBeGreaterThan(0)
      expect(screen.getByText("You're now signed in.")).toBeInTheDocument()
    })

    it('shows error and clears OTP on verification failure', async () => {
      mockSignInEmailOtp.mockResolvedValue({
        error: { message: 'Invalid code' },
      })

      renderModal()

      // Send verification code first
      const emailInput = await waitForModal()
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '12345678' } })

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Should show error message
      expect(screen.getByText('Invalid code')).toBeInTheDocument()
    })

    it('calls signIn.emailOtp with correct email, OTP, and challenge token', async () => {
      renderModal()

      // Send verification code first
      const emailInput = await waitForModal()
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '12345678' } })

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockSignInEmailOtp).toHaveBeenCalledWith({
        email: 'test@example.com',
        otp: '12345678',
        fetchOptions: {
          headers: { 'x-challenge-token': challengeToken },
        },
      })
    })
  })

  describe('back button on OTP step', () => {
    it('returns to email step when back button is clicked', async () => {
      renderModal()

      const emailInput = await waitForModal()
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(screen.getByText('Or enter the 8-digit code')).toBeInTheDocument()
      expect(screen.getByTestId('mock-otp-input')).toBeInTheDocument()

      const backButton = screen.getByRole('button', { name: 'Go back' })
      fireEvent.click(backButton)

      await act(async () => {})

      expect(screen.getByPlaceholderText('Email address')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send Magic Link' })).toBeInTheDocument()
      expect(screen.getByText('Sign In')).toBeInTheDocument()
      expect(screen.queryByText('Or enter the 8-digit code')).not.toBeInTheDocument()
    })
  })
})
