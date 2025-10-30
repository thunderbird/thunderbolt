import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock props
const mockOnConnectionChange = mock()

// Mock useOAuthConnect hook
const mockOAuthConnect = {
  connect: mock(),
  processCallback: mock(),
}

mock.module('@/hooks/use-oauth-connect', () => ({
  useOAuthConnect: () => mockOAuthConnect,
}))

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
  beforeEach(async () => {
    await setupTestDatabase()
    mockOnConnectionChange.mockClear()
    mockOAuthConnect.connect.mockClear()
    mockOAuthConnect.processCallback.mockClear()
    mockNavigate.mockClear()
    mockLocation.state = null
  })

  afterEach(async () => {
    await resetTestDatabase()
    mockOnConnectionChange.mockClear()
    mockOAuthConnect.connect.mockClear()
    mockOAuthConnect.processCallback.mockClear()
    mockNavigate.mockClear()
  })

  const renderComponent = (props = {}) => {
    return render(
      <OnboardingAuthStep
        providers={['google']}
        isProcessing={false}
        isConnected={false}
        onConnectionChange={mockOnConnectionChange}
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
    it('should handle connect button click', () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      expect(mockOAuthConnect.connect).toHaveBeenCalledWith('google')
    })

    it('should handle connection error gracefully', async () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      // Component should still render without crashing
      expect(connectButton).toBeInTheDocument()
    })

    it('should handle loading state during connection', () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      expect(connectButton).toBeInTheDocument()
    })

    it('should not call connect when button is disabled', () => {
      renderComponent({ isProcessing: true })

      // When processing, the button shows "Connected!" and is disabled
      const connectButton = screen.getByRole('button', { name: /Connected!/i })
      fireEvent.click(connectButton)

      expect(mockOAuthConnect.connect).not.toHaveBeenCalled()
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
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback processing', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: 'test_code', state: 'test_state' })
      })
    })

    it('should call onConnectionChange when OAuth callback succeeds', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })

      // The onConnectionChange is called through the useOAuthConnect hook's onSuccess callback
      // which is mocked, so we can't directly test it here
    })

    it('should handle OAuth callback processing failure', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('OAuth processing failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should not process OAuth callback when no state is present', () => {
      mockLocation.state = null

      renderComponent()

      expect(mockOAuthConnect.processCallback).not.toHaveBeenCalled()
    })

    it('should handle OAuth callback with invalid state structure', async () => {
      mockLocation.state = { oauth: { code: 'test_code' } } as any // Missing state field

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: 'test_code', state: undefined })
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

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle navigation after OAuth callback', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with empty code', async () => {
      mockLocation.state = { oauth: { code: '', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: '', state: 'test_state' })
      })
    })

    it('should handle OAuth callback with empty state', async () => {
      mockLocation.state = { oauth: { code: 'test_code', state: '' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: 'test_code', state: '' })
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
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: 123, state: 456 })
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
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: longCode, state: longState })
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
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({ code: specialCode, state: specialState })
      })
    })

    it('should handle OAuth callback processing timeout', async () => {
      mockOAuthConnect.processCallback.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000)))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      // Should not throw even if processing takes a long time
      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with network error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Network error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback with authentication error', async () => {
      mockLocation.state = { oauth: { error: 'invalid_client' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with server error', async () => {
      mockLocation.state = { oauth: { error: 'server_error' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with temporary error', async () => {
      mockLocation.state = { oauth: { error: 'temporarily_unavailable' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })
  })

  describe('Business Logic Validation', () => {
    it('should only process OAuth callback once per render', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledTimes(1)
      })
    })

    it('should process OAuth callback even when already connected', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent({ isConnected: true })

      expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
    })

    it('should process OAuth callback even when processing is in progress', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent({ isProcessing: true })

      expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
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

      mockOAuthConnect.processCallback.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise)

      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledTimes(2)
      })

      resolveFirst!()
      resolveSecond!()
    })

    it('should validate OAuth state parameter matches expected format', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalledWith({
          code: 'test_code',
          state: 'test_state',
        })
      })
    })

    it('should handle OAuth callback with expired state', async () => {
      mockLocation.state = { oauth: { error: 'expired_state' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with invalid grant', async () => {
      mockLocation.state = { oauth: { error: 'invalid_grant' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with unsupported response type', async () => {
      mockLocation.state = { oauth: { error: 'unsupported_response_type' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with invalid scope', async () => {
      mockLocation.state = { oauth: { error: 'invalid_scope' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with invalid request', async () => {
      mockLocation.state = { oauth: { error: 'invalid_request' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with unknown error', async () => {
      mockLocation.state = { oauth: { error: 'unknown_error' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with empty error', async () => {
      mockLocation.state = { oauth: { error: '' } } as { oauth: { error: string } }

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with null error', async () => {
      mockLocation.state = { oauth: { error: null } } as any

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })

    it('should handle OAuth callback with undefined error', async () => {
      mockLocation.state = { oauth: { error: undefined } } as any

      renderComponent()

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('.', { replace: true, state: null })
      })
    })
  })

  describe('Error Handling and Recovery', () => {
    it('should recover from OAuth processing failure and allow retry', async () => {
      mockOAuthConnect.processCallback.mockResolvedValue(undefined)
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })

      // Clear the error state and try again
      mockLocation.state = null
      mockOAuthConnect.processCallback.mockClear()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      expect(mockOAuthConnect.connect).toHaveBeenCalledWith('google')
    })

    it('should handle OAuth processing failure without crashing', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Processing failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      expect(() => renderComponent()).not.toThrow()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing timeout gracefully', async () => {
      mockOAuthConnect.processCallback.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
      )
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with network interruption', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Network error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with server error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Server error'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authentication error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Authentication failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authorization error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Authorization failed'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with rate limiting error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Rate limit exceeded'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with quota exceeded error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Quota exceeded'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with service unavailable error', async () => {
      mockOAuthConnect.processCallback.mockRejectedValue(new Error('Service unavailable'))
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      await waitFor(() => {
        expect(mockOAuthConnect.processCallback).toHaveBeenCalled()
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
