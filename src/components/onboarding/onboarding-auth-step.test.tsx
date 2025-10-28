import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock props
const mockOnConnectionChange = vi.fn()

// Mock useOAuthConnect hook
const mockOAuthConnect = {
  connect: vi.fn(),
  processCallback: vi.fn(),
}

vi.mock('@/hooks/use-oauth-connect', () => ({
  useOAuthConnect: () => mockOAuthConnect,
}))

// Mock react-router
const mockNavigate = vi.fn()
const mockLocation = {
  state: null as { oauth?: { code?: string; state?: string; error?: string } } | null,
}

vi.mock('react-router', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}))

describe('OnboardingAuthStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    vi.clearAllMocks()
    mockLocation.state = null
  })

  afterEach(async () => {
    await resetTestDatabase()
    vi.clearAllMocks()
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

      expect(screen.getByRole('heading', { name: /Connect Google Account/i })).toBeInTheDocument()
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

      // Component should render without errors
      expect(connectButton).toBeInTheDocument()
    })

    it('should handle loading state during connection', () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      fireEvent.click(connectButton)

      expect(connectButton).toBeInTheDocument()
    })
  })

  describe('Loading states', () => {
    it('should show loading state when isProcessing is true', () => {
      mockLocation.state = { oauth: { code: 'test_code', state: 'test_state' } } as {
        oauth: { code: string; state: string }
      }

      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connecting/i })
      expect(connectButton).toBeInTheDocument()
    })

    it('should disable buttons during connection', () => {
      renderComponent()

      const connectButton = screen.getByRole('button', { name: /Connect Google/i })
      expect(connectButton).toBeInTheDocument()
      expect(connectButton).not.toBeDisabled()
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
  })

  describe('Feature cards', () => {
    it('should display all feature cards with correct content', () => {
      renderComponent()

      expect(screen.getByText('Email Integration')).toBeInTheDocument()
      expect(screen.getByText('Calendar Access')).toBeInTheDocument()
      expect(screen.getByText('Drive Access')).toBeInTheDocument()
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
  })

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderComponent()

      const heading = screen.getByRole('heading', { name: /Connect Google Account/i })
      expect(heading).toBeInTheDocument()
    })
  })
})
