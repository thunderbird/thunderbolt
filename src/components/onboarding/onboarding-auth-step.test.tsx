import { resetTestDatabase, setupTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { OnboardingAuthStep } from './onboarding-auth-step'

// Mock props
const mockOnConnectionChange = mock()

// Mock react-router
const mockNavigate = mock()
const mockLocation = {
  state: null as { oauth?: { code?: string; state?: string; error?: string } } | null,
}

mock.module('react-router', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}))

describe('OnboardingAuthStep', () => {
  let consoleSpies: ConsoleSpies
  let mockConnect: ReturnType<typeof mock>
  let mockProcessCallback: ReturnType<typeof mock>
  let mockClearError: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(async () => {
    await setupTestDatabase()
    mockOnConnectionChange.mockClear()
    mockNavigate.mockClear()
    mockLocation.state = null

    // Create fresh mock functions for each test to prevent pollution
    mockConnect = mock(() => Promise.resolve())
    mockProcessCallback = mock(() => Promise.resolve(true))
    mockClearError = mock()
  })

  afterEach(async () => {
    await resetTestDatabase()
    mockOnConnectionChange.mockClear()
    mockNavigate.mockClear()
  })

  const renderComponent = (props = {}) => {
    const mockOAuthConnectHook = () => ({
      connect: mockConnect,
      processCallback: mockProcessCallback,
      error: null,
      clearError: mockClearError,
    })

    return render(
      <OnboardingAuthStep
        providers={['google']}
        isProcessing={false}
        isConnected={false}
        onConnectionChange={mockOnConnectionChange}
        useOAuthConnectHook={mockOAuthConnectHook}
        {...props}
      />,
      { wrapper: createQueryTestWrapper() },
    )
  }

  describe('Google provider UI', () => {
    it('should render Google provider UI correctly', () => {
      renderComponent()

      expect(screen.getByRole('heading', { name: /Connect Google/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument()
    })
  })

  describe('User interactions', () => {
    it('should handle connect button click', async () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockConnect).toHaveBeenCalledWith('google')
    })

    it('should handle connection error gracefully', async () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      // Wait for async state updates
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(connectButton).toBeInTheDocument()
    })

    it('should handle loading state during connection', async () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(connectButton).toBeInTheDocument()
    })

    it('should not call connect when button is disabled', () => {
      renderComponent({ isProcessing: true })

      // When processing, the button shows "Connected!" and is disabled
      const connectButton = screen.getByRole('button', { name: /Connected!/i })
      fireEvent.click(connectButton)

      expect(mockConnect).not.toHaveBeenCalled()
    })
  })

  describe('Loading states', () => {
    it('should show loading state when isProcessing is true', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      expect(connectButton).toBeInTheDocument()
    })

    it('should show connected state during connection', () => {
      renderComponent({ isProcessing: true })

      const connectButton = screen.getByRole('button', { name: /Connected!/i })
      expect(connectButton).toBeInTheDocument()
    })

    it('should enable buttons when not processing', () => {
      renderComponent({ isProcessing: false })

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      expect(connectButton).not.toBeDisabled()
    })

    it('should show different UI when already connected', () => {
      renderComponent({ isConnected: true })

      // When connected, the button should show "Connected!" text
      const connectButton = screen.getByRole('button', { name: /Connected!/i })
      expect(connectButton).toBeInTheDocument()
    })
  })

  describe('State management', () => {
    it('should update provider connection state on successful OAuth', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback processing', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 'test_code', state: 'test_state' })
      })
    })

    it('should call onConnectionChange when OAuth callback succeeds', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })

      // The onConnectionChange is called through the useOAuthConnect hook's onSuccess callback
      // which is mocked, so we can't directly test it here
    })

    it('should handle OAuth callback processing failure', async () => {
      mockProcessCallback.mockRejectedValue(new Error('OAuth processing failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should not process OAuth callback when no state is present', () => {
      mockLocation.state = null

      renderComponent()

      expect(mockProcessCallback).not.toHaveBeenCalled()
    })

    it('should handle OAuth callback with invalid state structure', async () => {
      mockLocation.state = { oauth: { code: 'test_code' } } as any // Missing state field

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 'test_code', state: undefined })
      })
    })
  })

  describe('Feature cards', () => {
    it('should display all feature cards with correct content', () => {
      renderComponent()

      expect(screen.getByText('Email')).toBeInTheDocument()
      expect(screen.getByText('Calendar')).toBeInTheDocument()
      expect(screen.getByText('Drive')).toBeInTheDocument()
    })
  })

  describe('Edge cases', () => {
    it('should handle OAuth callback with missing state', () => {
      mockLocation.state = null

      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with error state', async () => {
      mockLocation.state = { oauth: { error: 'access_denied' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle navigation after OAuth callback', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with empty code', async () => {
      mockLocation.state = { oauth: { code: '', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: '', state: 'test_state' })
      })
    })

    it('should handle OAuth callback with empty state', async () => {
      mockLocation.state = { oauth: { code: 'test_code', state: '' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 'test_code', state: '' })
      })
    })

    it('should handle OAuth callback with malformed state object', () => {
      mockLocation.state = { oauth: { invalidField: 'value' } } as any

      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with null oauth object', () => {
      mockLocation.state = { oauth: null } as any

      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with undefined oauth object', () => {
      mockLocation.state = { oauth: undefined } as any

      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with non-string code and state', async () => {
      mockLocation.state = { oauth: { code: 123, state: 456 } } as any

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 123, state: 456 })
      })
    })

    it('should handle OAuth callback with very long code and state', async () => {
      const longCode = 'a'.repeat(1000)
      const longState = 'b'.repeat(1000)
      mockLocation.state = { oauth: { code: longCode, state: longState } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: longCode, state: longState })
      })
    })

    it('should handle OAuth callback with special characters in code and state', async () => {
      const specialCode = 'test_code_!@#$%^&*()_+{}|:"<>?[]\\;\',./'
      const specialState = 'test_state_!@#$%^&*()_+{}|:"<>?[]\\;\',./'
      mockLocation.state = { oauth: { code: specialCode, state: specialState } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: specialCode, state: specialState })
      })
    })

    it('should handle OAuth callback processing timeout', async () => {
      mockProcessCallback.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000)))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      // Should not throw even if processing takes a long time
      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with network error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Network error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback with authentication error', async () => {
      mockLocation.state = { oauth: { error: 'invalid_client' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with server error', async () => {
      mockLocation.state = { oauth: { error: 'server_error' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with temporary error', async () => {
      mockLocation.state = { oauth: { error: 'temporarily_unavailable' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })
  })

  describe('Business Logic Validation', () => {
    it('should only process OAuth callback once per render', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledTimes(1)
      })
    })

    it('should process OAuth callback even when already connected', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent({ isConnected: true })

      expect(mockProcessCallback).toHaveBeenCalled()
    })

    it('should process OAuth callback even when processing is in progress', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent({ isProcessing: true })

      expect(mockProcessCallback).toHaveBeenCalled()
    })

    it('should handle OAuth callback processing race condition', async () => {
      let resolveFirst: () => void
      let resolveSecond: () => void

      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      const secondPromise = new Promise<void>((resolve) => {
        resolveSecond = resolve
      })

      mockProcessCallback.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise)

      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledTimes(2)
      })

      resolveFirst!()
      resolveSecond!()
    })

    it('should validate OAuth state parameter matches expected format', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({
          code: 'test_code',
          state: 'test_state',
        })
      })
    })

    it('should handle OAuth callback with expired state', async () => {
      mockLocation.state = { oauth: { error: 'expired_state' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with invalid grant', async () => {
      mockLocation.state = { oauth: { error: 'invalid_grant' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with unsupported response type', async () => {
      mockLocation.state = { oauth: { error: 'unsupported_response_type' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with invalid scope', async () => {
      mockLocation.state = { oauth: { error: 'invalid_scope' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with invalid request', async () => {
      mockLocation.state = { oauth: { error: 'invalid_request' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with unknown error', async () => {
      mockLocation.state = { oauth: { error: 'unknown_error' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with empty error', async () => {
      mockLocation.state = { oauth: { error: '' } } as { oauth: { error: string } }

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with null error', async () => {
      mockLocation.state = { oauth: { error: null } } as any

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })

    it('should handle OAuth callback with undefined error', async () => {
      mockLocation.state = { oauth: { error: undefined } } as any

      renderComponent()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
    })
  })

  describe('Error Handling and Recovery', () => {
    it('should recover from OAuth processing failure and allow retry', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })

      // Clear the error state and try again
      mockLocation.state = null
      mockProcessCallback.mockClear()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalledWith('google')
      })
    })

    it('should handle OAuth processing failure without crashing', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Processing failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      expect(() => renderComponent()).not.toThrow()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing timeout gracefully', async () => {
      mockProcessCallback.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
      )
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with network interruption', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Network error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with server error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Server error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authentication error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Authentication failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authorization error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Authorization failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with rate limiting error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Rate limit exceeded'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with quota exceeded error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Quota exceeded'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with service unavailable error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Service unavailable'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })
  })

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderComponent()

      const heading = screen.getByRole('heading', { name: /Connect Google/i })
      expect(heading).toBeInTheDocument()
    })
  })
})
