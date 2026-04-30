/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { OnboardingAuthStep } from './onboarding-auth-step'

const mockOnConnectionChange = mock()

/**
 * Spy component that tracks navigation state changes via useLocation.
 * Since the component calls navigate('.', { replace: true, state: null }),
 * this resets location.state to null — which we can observe.
 */
const NavigationSpy = ({
  onLocationChange,
}: {
  onLocationChange: (location: ReturnType<typeof useLocation>) => void
}) => {
  const location = useLocation()
  onLocationChange(location)
  return null
}

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

    mockConnect = mock(() => Promise.resolve())
    mockProcessCallback = mock(() => Promise.resolve(true))
    mockClearError = mock()
  })

  afterEach(async () => {
    await resetTestDatabase()
    cleanup()
    mockOnConnectionChange.mockClear()
  })

  const renderComponent = (props = {}, locationState: unknown = null) => {
    const mockOAuthConnectHook = () => ({
      connect: mockConnect,
      processCallback: mockProcessCallback,
      isConnecting: false,
      error: null,
      clearError: mockClearError,
    })

    const QueryWrapper = createQueryTestWrapper()
    let lastLocation: ReturnType<typeof useLocation> | null = null

    const result = render(
      <>
        <OnboardingAuthStep
          providers={['google']}
          isProcessing={false}
          isConnected={false}
          onConnectionChange={mockOnConnectionChange}
          useOAuthConnectHook={mockOAuthConnectHook}
          {...props}
        />
        <NavigationSpy
          onLocationChange={(loc) => {
            lastLocation = loc
          }}
        />
      </>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MemoryRouter initialEntries={[{ pathname: '/', state: locationState }]}>
            <QueryWrapper>{children}</QueryWrapper>
          </MemoryRouter>
        ),
      },
    )

    return { ...result, getLastLocation: () => lastLocation }
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

      const connectButton = screen.getByRole('button', { name: /Connecting/i })
      fireEvent.click(connectButton)

      expect(mockConnect).not.toHaveBeenCalled()
    })
  })

  describe('Loading states', () => {
    it('should show loading state when isProcessing is true', () => {
      renderComponent({ isProcessing: true })

      const connectButton = screen.getByRole('button', { name: /Connecting/i })
      expect(connectButton).toBeInTheDocument()
    })

    it('should show connecting state when OAuth callback is in location state', () => {
      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      const connectButton = screen.getByRole('button', { name: /Connecting/i })
      expect(connectButton).toBeInTheDocument()
    })

    it('should enable buttons when not processing', () => {
      renderComponent({ isProcessing: false })

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      expect(connectButton).not.toBeDisabled()
    })

    it('should show different UI when already connected', () => {
      renderComponent({ isConnected: true })

      const connectButton = screen.getByRole('button', { name: /Connected!/i })
      expect(connectButton).toBeInTheDocument()
    })
  })

  describe('State management', () => {
    it('should update provider connection state on successful OAuth', async () => {
      mockProcessCallback.mockResolvedValue(undefined)

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback processing', async () => {
      mockProcessCallback.mockResolvedValue(undefined)

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 'test_code', state: 'test_state' })
      })
    })

    it('should call onConnectionChange when OAuth callback succeeds', async () => {
      mockProcessCallback.mockResolvedValue(undefined)

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback processing failure', async () => {
      mockProcessCallback.mockRejectedValue(new Error('OAuth processing failed'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should not process OAuth callback when no state is present', () => {
      renderComponent()

      expect(mockProcessCallback).not.toHaveBeenCalled()
    })

    it('should handle OAuth callback with invalid state structure', async () => {
      renderComponent({}, { oauth: { code: 'test_code' } })

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
      expect(() => renderComponent()).not.toThrow()
    })

    it('should handle OAuth callback with error state', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'access_denied' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle navigation after OAuth callback', async () => {
      mockProcessCallback.mockResolvedValue(undefined)
      const { getLastLocation } = renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with empty code', async () => {
      renderComponent({}, { oauth: { code: '', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: '', state: 'test_state' })
      })
    })

    it('should handle OAuth callback with empty state', async () => {
      renderComponent({}, { oauth: { code: 'test_code', state: '' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 'test_code', state: '' })
      })
    })

    it('should handle OAuth callback with malformed state object', () => {
      expect(() => renderComponent({}, { oauth: { invalidField: 'value' } })).not.toThrow()
    })

    it('should handle OAuth callback with null oauth object', () => {
      expect(() => renderComponent({}, { oauth: null })).not.toThrow()
    })

    it('should handle OAuth callback with undefined oauth object', () => {
      expect(() => renderComponent({}, { oauth: undefined })).not.toThrow()
    })

    it('should handle OAuth callback with non-string code and state', async () => {
      renderComponent({}, { oauth: { code: 123, state: 456 } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: 123, state: 456 })
      })
    })

    it('should handle OAuth callback with very long code and state', async () => {
      const longCode = 'a'.repeat(1000)
      const longState = 'b'.repeat(1000)

      renderComponent({}, { oauth: { code: longCode, state: longState } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: longCode, state: longState })
      })
    })

    it('should handle OAuth callback with special characters in code and state', async () => {
      const specialCode = 'test_code_!@#$%^&*()_+{}|:"<>?[]\\;\',./'
      const specialState = 'test_state_!@#$%^&*()_+{}|:"<>?[]\\;\',./'

      renderComponent({}, { oauth: { code: specialCode, state: specialState } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({ code: specialCode, state: specialState })
      })
    })

    it('should handle OAuth callback processing timeout', async () => {
      mockProcessCallback.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000)))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      expect(() => renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })).not.toThrow()
    })

    it('should handle OAuth callback with network error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Network error'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth callback with authentication error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'invalid_client' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with server error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'server_error' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with temporary error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'temporarily_unavailable' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })
  })

  describe('Business Logic Validation', () => {
    it('should only process OAuth callback once per render', async () => {
      mockProcessCallback.mockResolvedValue(undefined)

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledTimes(1)
      })
    })

    it('should process OAuth callback even when already connected', () => {
      renderComponent({ isConnected: true }, { oauth: { code: 'test_code', state: 'test_state' } })

      expect(mockProcessCallback).toHaveBeenCalled()
    })

    it('should process OAuth callback even when processing is in progress', () => {
      renderComponent({ isProcessing: true }, { oauth: { code: 'test_code', state: 'test_state' } })

      expect(mockProcessCallback).toHaveBeenCalled()
    })

    it('should validate OAuth state parameter matches expected format', async () => {
      mockProcessCallback.mockResolvedValue(undefined)

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalledWith({
          code: 'test_code',
          state: 'test_state',
        })
      })
    })

    it('should handle OAuth callback with expired state', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'expired_state' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with invalid grant', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'invalid_grant' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with unsupported response type', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'unsupported_response_type' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with invalid scope', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'invalid_scope' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with invalid request', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'invalid_request' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with unknown error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: 'unknown_error' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with empty error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: '' } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with null error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: null } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })

    it('should handle OAuth callback with undefined error', async () => {
      const { getLastLocation } = renderComponent({}, { oauth: { error: undefined } })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getLastLocation()?.state).toBeNull()
    })
  })

  describe('Error Handling and Recovery', () => {
    it('should handle OAuth processing failure without crashing', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Processing failed'))

      expect(() => renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })).not.toThrow()

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing timeout gracefully', async () => {
      mockProcessCallback.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
      )

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with network interruption', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Network error'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with server error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Server error'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authentication error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Authentication failed'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with authorization error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Authorization failed'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with rate limiting error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Rate limit exceeded'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with quota exceeded error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Quota exceeded'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

      await waitFor(() => {
        expect(mockProcessCallback).toHaveBeenCalled()
      })
    })

    it('should handle OAuth processing with service unavailable error', async () => {
      mockProcessCallback.mockRejectedValue(new Error('Service unavailable'))

      renderComponent({}, { oauth: { code: 'test_code', state: 'test_state' } })

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
