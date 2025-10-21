import { describe, expect, it, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { OnboardingFooter } from './onboarding-footer'

describe('OnboardingFooter', () => {
  describe('Button rendering', () => {
    it('should render all buttons with default props', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} />)

      // Verify continue button is present
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()

      // Verify back button is present (default showBack=true)
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()

      // Verify skip button is present (default showSkip=true)
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    })

    it('should render with custom continue text', () => {
      const onContinue = mock()

      render(<OnboardingFooter onContinue={onContinue} continueText="Get Started" />)

      expect(screen.getByRole('button', { name: 'Get Started' })).toBeInTheDocument()
    })

    it('should hide back button when showBack is false', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} showBack={false} />)

      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    })

    it('should hide skip button when showSkip is false', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} showSkip={false} />)

      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    })

    it('should hide back button when onBack is not provided', () => {
      const onContinue = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onSkip={onSkip} />)

      // Back button should not be rendered when onBack is not provided
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    })

    it('should hide skip button when onSkip is not provided', () => {
      const onContinue = mock()
      const onBack = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} />)

      // Skip button should not be rendered when onSkip is not provided
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    })
  })

  describe('User interactions', () => {
    it('should call onContinue when continue button is clicked', () => {
      const onContinue = mock()

      render(<OnboardingFooter onContinue={onContinue} />)

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(continueButton)

      expect(onContinue).toHaveBeenCalledTimes(1)
    })

    it('should call onBack when back button is clicked', () => {
      const onContinue = mock()
      const onBack = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} />)

      const backButton = screen.getByRole('button', { name: 'Back' })
      fireEvent.click(backButton)

      expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('should call onSkip when skip button is clicked', () => {
      const onContinue = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onSkip={onSkip} />)

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(onSkip).toHaveBeenCalledTimes(1)
    })
  })

  describe('Disabled states', () => {
    it('should disable continue button when continueDisabled is true', () => {
      const onContinue = mock()

      render(<OnboardingFooter onContinue={onContinue} continueDisabled={true} />)

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toBeDisabled()
    })

    it('should disable skip button when continueDisabled is true', () => {
      const onContinue = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onSkip={onSkip} continueDisabled={true} />)

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      expect(skipButton).toBeDisabled()
    })

    it('should not disable back button when continueDisabled is true', () => {
      const onContinue = mock()
      const onBack = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} continueDisabled={true} />)

      const backButton = screen.getByRole('button', { name: 'Back' })
      expect(backButton).not.toBeDisabled()
    })

    it('should not call callbacks when buttons are disabled', () => {
      const onContinue = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onSkip={onSkip} continueDisabled={true} />)

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      // Clicking disabled buttons should not trigger callbacks
      fireEvent.click(continueButton)
      fireEvent.click(skipButton)

      expect(onContinue).not.toHaveBeenCalled()
      expect(onSkip).not.toHaveBeenCalled()
    })
  })

  describe('Button layout and styling', () => {
    it('should render back button with ArrowLeft icon', () => {
      const onContinue = mock()
      const onBack = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} />)

      const backButton = screen.getByRole('button', { name: 'Back' })
      expect(backButton).toBeInTheDocument()

      // Verify ArrowLeft icon is present (check for SVG)
      const svgElement = backButton.querySelector('svg')
      expect(svgElement).toBeInTheDocument()
    })

    it('should have proper button grouping', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} />)

      // Back button should be on the left
      const backButton = screen.getByRole('button', { name: 'Back' })
      expect(backButton).toBeInTheDocument()

      // Continue and Skip buttons should be on the right
      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      expect(continueButton).toBeInTheDocument()
      expect(skipButton).toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper button roles and labels', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} />)

      // All buttons should have proper roles
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    })

    it('should maintain accessibility when buttons are disabled', () => {
      const onContinue = mock()
      const onBack = mock()
      const onSkip = mock()

      render(<OnboardingFooter onContinue={onContinue} onBack={onBack} onSkip={onSkip} continueDisabled={true} />)

      // Buttons should still be accessible even when disabled
      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      expect(continueButton).toBeDisabled()
      expect(skipButton).toBeDisabled()
      expect(continueButton).toBeInTheDocument()
      expect(skipButton).toBeInTheDocument()
    })
  })

  describe('Edge cases', () => {
    it('should handle all buttons hidden', () => {
      const onContinue = mock()

      render(<OnboardingFooter onContinue={onContinue} showBack={false} showSkip={false} />)

      // Only continue button should be visible
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
    })

    it('should handle empty continue text', () => {
      const onContinue = mock()

      render(<OnboardingFooter onContinue={onContinue} continueText="" />)

      // Button should still be rendered even with empty text
      const continueButton = screen.getByRole('button', { name: '' })
      expect(continueButton).toBeInTheDocument()
    })

    it('should handle very long continue text', () => {
      const onContinue = mock()
      const longText = 'This is a very long button text that might cause layout issues'

      render(<OnboardingFooter onContinue={onContinue} continueText={longText} />)

      expect(screen.getByRole('button', { name: longText })).toBeInTheDocument()
    })
  })
})
