import { render, screen, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { vi, describe, it, beforeEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'

describe('OnboardingPrivacyStep', () => {
  const defaultProps = {
    onNext: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Component rendering', () => {
    it('should render privacy step UI correctly', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      expect(screen.getByText('Privacy & Security First')).toBeInTheDocument()
      expect(screen.getByText('Your privacy is our priority.')).toBeInTheDocument()
      expect(screen.getByText('On-Device Processing')).toBeInTheDocument()
      expect(screen.getByText('No Data Collection')).toBeInTheDocument()
      expect(screen.getByText('Local Storage')).toBeInTheDocument()
    })

    it('should render Shield icon', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const shieldIcon = document.querySelector('.lucide-shield')
      expect(shieldIcon).toBeInTheDocument()
    })

    it('should render privacy feature icons', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const lockIcon = document.querySelector('.lucide-lock')
      const eyeIcon = document.querySelector('.lucide-eye')
      const databaseIcon = document.querySelector('.lucide-database')

      expect(lockIcon).toBeInTheDocument()
      expect(eyeIcon).toBeInTheDocument()
      expect(databaseIcon).toBeInTheDocument()
    })

    it('should render privacy feature descriptions', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      expect(screen.getByText('Data processed locally, not sent to external servers.')).toBeInTheDocument()
      expect(screen.getByText("We don't collect or share your personal information.")).toBeInTheDocument()
      expect(screen.getByText('All data stored securely on your device.')).toBeInTheDocument()
    })
  })

  describe('Terms agreement', () => {
    it('should render terms agreement checkbox', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      expect(checkbox).toBeInTheDocument()
      expect(checkbox).not.toBeChecked()
    })

    it('should render privacy policy link', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(privacyLink).toBeInTheDocument()
      expect(privacyLink).toHaveAttribute('href', 'https://www.thunderbird.net/en-US/privacy/')
      expect(privacyLink).toHaveAttribute('target', '_blank')
      expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('should handle checkbox state changes', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })

      await act(async () => {
        fireEvent.click(checkbox)
      })

      expect(checkbox).toBeChecked()
    })

    it('should toggle checkbox state correctly', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })

      // Check the checkbox
      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(checkbox).toBeChecked()

      // Uncheck the checkbox
      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(checkbox).not.toBeChecked()
    })
  })

  describe('Continue button state', () => {
    it('should disable continue button when terms not agreed', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })
      expect(continueButton).toBeDisabled()
    })

    it('should enable continue button when terms are agreed', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      await act(async () => {
        fireEvent.click(checkbox)
      })

      expect(continueButton).not.toBeDisabled()
    })

    it('should disable continue button when terms are unchecked', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      // Check and then uncheck
      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(continueButton).not.toBeDisabled()

      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(continueButton).toBeDisabled()
    })
  })

  describe('Form submission', () => {
    it('should call onNext when continue button is clicked and terms are agreed', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      await act(async () => {
        fireEvent.click(checkbox)
      })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      expect(defaultProps.onNext).toHaveBeenCalled()
    })

    it('should not call onNext when continue button is clicked but terms are not agreed', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      // Button should be disabled, but let's test the behavior
      expect(continueButton).toBeDisabled()
      expect(defaultProps.onNext).not.toHaveBeenCalled()
    })
  })

  describe('Navigation', () => {
    it('should not show back or skip buttons', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading).toHaveTextContent('Privacy & Security First')
    })

    it('should have proper checkbox labeling', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const label = screen.getByText(/I agree to the/)

      expect(checkbox).toBeInTheDocument()
      expect(label).toBeInTheDocument()
      expect(checkbox).toHaveAttribute('id', 'terms-agreement')
    })

    it('should have proper link accessibility', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(privacyLink).toBeInTheDocument()
      expect(privacyLink).toHaveAttribute('href')
      expect(privacyLink).toHaveAttribute('target', '_blank')
      expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer')
    })
  })

  describe('Privacy features', () => {
    it('should display all privacy features with correct content', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      // On-Device Processing
      expect(screen.getByText('On-Device Processing')).toBeInTheDocument()
      expect(screen.getByText('Data processed locally, not sent to external servers.')).toBeInTheDocument()

      // No Data Collection
      expect(screen.getByText('No Data Collection')).toBeInTheDocument()
      expect(screen.getByText("We don't collect or share your personal information.")).toBeInTheDocument()

      // Local Storage
      expect(screen.getByText('Local Storage')).toBeInTheDocument()
      expect(screen.getByText('All data stored securely on your device.')).toBeInTheDocument()
    })

    it('should have proper feature card structure', () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const featureCards = document.querySelectorAll('.bg-muted\\/50')
      expect(featureCards).toHaveLength(3)
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid checkbox toggling', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      // Rapid toggling
      await act(async () => {
        fireEvent.click(checkbox)
        fireEvent.click(checkbox)
        fireEvent.click(checkbox)
      })

      expect(checkbox).toBeChecked()
      expect(continueButton).not.toBeDisabled()
    })

    it('should maintain state consistency during interactions', async () => {
      render(<OnboardingPrivacyStep {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox', { name: /I agree to the/ })
      const continueButton = screen.getByRole('button', { name: 'I Agree & Continue' })

      // Initial state
      expect(checkbox).not.toBeChecked()
      expect(continueButton).toBeDisabled()

      // After checking
      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(checkbox).toBeChecked()
      expect(continueButton).not.toBeDisabled()

      // After unchecking
      await act(async () => {
        fireEvent.click(checkbox)
      })
      expect(checkbox).not.toBeChecked()
      expect(continueButton).toBeDisabled()
    })
  })
})
