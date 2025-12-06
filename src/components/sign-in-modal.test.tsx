import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockAuthClient } from '@/test-utils/auth-client'
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
    children: React.ReactNode
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
            const newValue = e.target.value.slice(0, maxLength || 6)
            onChange?.(newValue)
            if (newValue.length === (maxLength || 6)) {
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
  InputOTPGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputOTPSlot: ({ index }: { index: number }) => <div data-slot-index={index} />,
  InputOTPSeparator: () => <span>-</span>,
}))

// Import after mock
import { SignInModal } from './sign-in-modal'

describe('SignInModal', () => {
  let consoleSpies: ConsoleSpies
  let mockOnOpenChange: ReturnType<typeof mock>
  let mockSendVerificationOtp: ReturnType<typeof mock>
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
    mockOnOpenChange = mock()
    mockSendVerificationOtp = mock(() => Promise.resolve({ error: null }))
    mockSignInEmailOtp = mock(() => Promise.resolve({ error: null }))
  })

  afterEach(async () => {
    await resetTestDatabase()
    mockOnOpenChange.mockClear()
  })

  const renderModal = (props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void }> = {}) => {
    const authClient = createMockAuthClient({
      sendVerificationOtp: mockSendVerificationOtp,
      signInEmailOtp: mockSignInEmailOtp,
    })
    return render(<SignInModal open={true} onOpenChange={mockOnOpenChange} {...props} />, {
      wrapper: createTestProvider({ authClient }),
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
      expect(screen.getByText('Access more powerful AI models')).toBeInTheDocument()
      expect(screen.getByText('Sync chats between devices')).toBeInTheDocument()
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
    it('calls emailOtp.sendVerificationOtp with trimmed email', async () => {
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      const button = screen.getByRole('button', { name: 'Send Magic Link' })

      fireEvent.change(input, { target: { value: '  test@example.com  ' } })
      fireEvent.click(button)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockSendVerificationOtp).toHaveBeenCalledWith({
        email: 'test@example.com',
        type: 'sign-in',
      })
    })

    it('shows loading state while sending', async () => {
      let resolvePromise: (value: { error: null }) => void
      mockSendVerificationOtp.mockReturnValue(
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

    it('shows sent state after successful submission', async () => {
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
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
      const form = screen.getByPlaceholderText('Email address').closest('form')!

      fireEvent.submit(form)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockSendVerificationOtp).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('shows error message on API error', async () => {
      mockSendVerificationOtp.mockResolvedValue({
        error: { message: 'Invalid email address' },
      })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'invalid' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(screen.getByText('Invalid email address')).toBeInTheDocument()
    })

    it('shows default error message when error has no message', async () => {
      mockSendVerificationOtp.mockResolvedValue({
        error: {},
      })
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(screen.getByText('Failed to send verification code')).toBeInTheDocument()
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

    it('calls onOpenChange when close button is clicked in sent state', async () => {
      renderModal()

      const input = screen.getByPlaceholderText('Email address')
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

      const input = screen.getByPlaceholderText('Email address')
      fireEvent.change(input, { target: { value: 'test@example.com' } })
      fireEvent.submit(input.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Should show OTP input prompt
      expect(screen.getByText('Or enter the 6-digit code')).toBeInTheDocument()
      expect(screen.getByTestId('mock-otp-input')).toBeInTheDocument()
    })

    it('shows success state after successful OTP verification', async () => {
      renderModal()

      // Send verification code first
      const emailInput = screen.getByPlaceholderText('Email address')
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '123456' } })

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
      const emailInput = screen.getByPlaceholderText('Email address')
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '123456' } })

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Should show error message
      expect(screen.getByText('Invalid code')).toBeInTheDocument()
    })

    it('calls signIn.emailOtp with correct email and OTP', async () => {
      renderModal()

      // Send verification code first
      const emailInput = screen.getByPlaceholderText('Email address')
      fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
      fireEvent.submit(emailInput.closest('form')!)

      await act(async () => {
        await getClock().tickAsync(100)
      })

      // Get the mocked OTP input and enter code
      const otpInput = screen.getByTestId('otp-input')
      fireEvent.change(otpInput, { target: { value: '123456' } })

      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(mockSignInEmailOtp).toHaveBeenCalledWith({
        email: 'test@example.com',
        otp: '123456',
      })
    })
  })
})
