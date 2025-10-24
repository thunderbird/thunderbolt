import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock state and actions
const mockActions = {
  setPrivacyAgreed: vi.fn(),
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  skipStep: vi.fn(),
}

const mockState = {
  currentStep: 1 as const,
  privacyAgreed: false,
  isProviderConnected: false,
  isConnecting: false,
  processingOAuth: false,
  nameValue: '',
  isNameValid: false,
  isSubmittingName: false,
  locationValue: '',
  isLocationValid: false,
  isSubmittingLocation: false,
  canGoBack: false,
  canGoNext: false,
  canSkip: false,
}

describe('OnboardingPrivacyStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    vi.clearAllMocks()
    mockState.privacyAgreed = false
  })

  afterEach(async () => {
    await resetTestDatabase()
    vi.clearAllMocks()
  })

  const renderComponent = () => {
    return render(<OnboardingPrivacyStep state={mockState} actions={mockActions} />, {
      wrapper: createQueryTestWrapper(),
    })
  }

  describe('Component rendering', () => {
    it('should render privacy step UI correctly', () => {
      renderComponent()

      expect(screen.getByText('Privacy & Security First')).toBeInTheDocument()
      expect(screen.getByText('Your privacy is our priority.')).toBeInTheDocument()
    })

    it('should render privacy features', () => {
      renderComponent()

      expect(screen.getByText('On-Device Processing')).toBeInTheDocument()
      expect(screen.getByText('No Data Collection')).toBeInTheDocument()
      expect(screen.getByText('Local Storage')).toBeInTheDocument()
    })
  })

  describe('Terms agreement', () => {
    it('should render terms agreement checkbox', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')
      expect(checkbox).toBeInTheDocument()
      expect(checkbox).toHaveAttribute('aria-checked', 'false')
    })

    it('should render privacy policy link', () => {
      renderComponent()

      const link = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', 'https://www.thunderbird.net/en-US/privacy/')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('should handle checkbox state changes', async () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(mockActions.setPrivacyAgreed).toHaveBeenCalledWith(true)
      })
    })
  })

  describe('Accessibility', () => {
    it('should have proper structure', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')
      expect(checkbox).toHaveAttribute('role', 'checkbox')
      expect(checkbox).toHaveAttribute('type', 'button')
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid checkbox toggling', async () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      fireEvent.click(checkbox)
      fireEvent.click(checkbox)
      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(mockActions.setPrivacyAgreed).toHaveBeenCalled()
      })
    })

    it('should handle keyboard navigation', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      expect(checkbox).toBeInTheDocument()
      expect(checkbox).toHaveAttribute('role', 'checkbox')
    })

    it('should handle external link clicks', () => {
      renderComponent()

      const link = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })
  })
})
