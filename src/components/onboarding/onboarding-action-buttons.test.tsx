/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, beforeEach, expect, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { OnboardingActionButtons } from './onboarding-action-buttons'

describe('OnboardingActionButtons', () => {
  const mockOnBack = mock()
  const mockOnSkip = mock()
  const mockOnContinue = mock()

  const defaultProps = {
    onBack: mockOnBack,
    onSkip: mockOnSkip,
    onContinue: mockOnContinue,
  }

  beforeEach(() => {
    mockOnBack.mockClear()
    mockOnSkip.mockClear()
    mockOnContinue.mockClear()
  })

  const renderComponent = (props = {}) => {
    return render(<OnboardingActionButtons {...defaultProps} {...props} />)
  }

  describe('Rendering', () => {
    it('should render back and skip buttons', () => {
      renderComponent()

      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)
      const skipButton = screen.getByRole('button', { name: 'Skip' })
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      expect(backButton).toBeInTheDocument()
      expect(skipButton).toBeInTheDocument()
      expect(continueButton).toBeInTheDocument()
    })

    it('should render back button with arrow icon', () => {
      renderComponent()

      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)
      expect(backButton).toBeInTheDocument()
    })
  })

  describe('User Interactions', () => {
    it('should call onBack when back button is clicked', () => {
      renderComponent()

      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)
      fireEvent.click(backButton)

      expect(mockOnBack).toHaveBeenCalledTimes(1)
    })

    it('should call onSkip when skip button is clicked', () => {
      renderComponent()

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(mockOnSkip).toHaveBeenCalledTimes(1)
    })

    it('should call onContinue when continue button is clicked', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(continueButton)

      expect(mockOnContinue).toHaveBeenCalledTimes(1)
    })

    it('should not call onBack when skip button is clicked', () => {
      renderComponent()

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(mockOnBack).not.toHaveBeenCalled()
    })

    it('should not call onSkip when back button is clicked', () => {
      renderComponent()

      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)
      fireEvent.click(backButton)

      expect(mockOnSkip).not.toHaveBeenCalled()
    })
  })

  describe('Button States', () => {
    it('should disable continue button when continueDisabled is true', () => {
      renderComponent({ continueDisabled: true })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toBeDisabled()
    })

    it('should disable skip button when skipDisabled is true', () => {
      renderComponent({ skipDisabled: true })

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      expect(skipButton).toBeDisabled()
    })

    it('should enable buttons when not disabled', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const skipButton = screen.getByRole('button', { name: 'Skip' })
      const backButton = screen.getAllByRole('button')[0]

      expect(continueButton).not.toBeDisabled()
      expect(skipButton).not.toBeDisabled()
      expect(backButton).not.toBeDisabled()
    })
  })

  describe('Button Visibility', () => {
    it('should hide back button when showBack is false', () => {
      renderComponent({ showBack: false })

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(2) // Skip and Continue only
    })

    it('should hide skip button when showSkip is false', () => {
      renderComponent({ showSkip: false })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)

      expect(continueButton).toBeInTheDocument()
      expect(backButton).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
    })

    it('should hide continue button when showContinue is false', () => {
      renderComponent({ showContinue: false })

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      const backButton = screen.getAllByRole('button')[0] // Back button (icon only)

      expect(skipButton).toBeInTheDocument()
      expect(backButton).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    })

    it('should show only continue button when showBack and showSkip are false', () => {
      renderComponent({ showBack: false, showSkip: false })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toBeInTheDocument()
      expect(continueButton).toHaveClass('w-full')
    })
  })

  describe('Custom Text', () => {
    it('should display custom continue text', () => {
      renderComponent({ continueText: 'Next Step' })

      const continueButton = screen.getByRole('button', { name: 'Next Step' })
      expect(continueButton).toBeInTheDocument()
    })

    it('should display default continue text when not provided', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toBeInTheDocument()
    })
  })

  describe('Layout and Structure', () => {
    it('should have proper flex layout', () => {
      const { container } = renderComponent()

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper).toHaveClass('flex', 'flex-1', 'w-full', 'justify-between')
    })

    it('should have responsive gap classes', () => {
      const { container } = renderComponent()

      const rightSection = container.querySelector('.flex.space-x-2')
      expect(rightSection).toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper button roles', () => {
      renderComponent()

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(3) // Back, Skip, Continue
    })

    it('should be keyboard accessible', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      const skipButton = screen.getByRole('button', { name: 'Skip' })
      const backButton = screen.getAllByRole('button')[0]

      expect(continueButton).toBeInTheDocument()
      expect(skipButton).toBeInTheDocument()
      expect(backButton).toBeInTheDocument()
    })

    it('should support keyboard navigation', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      continueButton.focus()
      expect(continueButton).toHaveFocus()
    })
  })

  describe('Edge Cases', () => {
    it('should handle multiple rapid clicks', () => {
      renderComponent()

      const continueButton = screen.getByRole('button', { name: 'Continue' })

      // Rapid clicks
      fireEvent.click(continueButton)
      fireEvent.click(continueButton)
      fireEvent.click(continueButton)

      expect(mockOnContinue).toHaveBeenCalledTimes(3)
    })

    it('should work with undefined callback functions', () => {
      renderComponent({ onBack: undefined, onSkip: undefined })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toBeInTheDocument()
    })

    it('should handle all buttons being hidden', () => {
      renderComponent({ showBack: false, showSkip: false, showContinue: false })

      const buttons = screen.queryAllByRole('button')
      expect(buttons).toHaveLength(0)
    })

    it('should handle conditional rendering based on props', () => {
      renderComponent({ onBack: undefined })

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(2) // Skip and Continue only
    })
  })

  describe('Button Styling', () => {
    it('should apply correct button variants', () => {
      renderComponent()

      const backButton = screen.getAllByRole('button')[0]
      const skipButton = screen.getByRole('button', { name: 'Skip' })
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      expect(backButton).toBeInTheDocument()
      expect(skipButton).toBeInTheDocument()
      expect(continueButton).toBeInTheDocument()
    })

    it('should apply full width to continue button when no other buttons', () => {
      renderComponent({ showBack: false, showSkip: false })

      const continueButton = screen.getByRole('button', { name: 'Continue' })
      expect(continueButton).toHaveClass('w-full')
    })
  })
})
