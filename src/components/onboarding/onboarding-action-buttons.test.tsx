import { render, screen, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingActionButtons } from './onboarding-action-buttons'

describe('OnboardingActionButtons', () => {
  const mockOnBack = vi.fn()
  const mockOnSkip = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('should render back and skip buttons', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    })

    it('should render back button with arrow icon', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0] // First button is the back button
      expect(backButton).toBeInTheDocument()

      // Check for arrow icon (ArrowLeft component)
      const arrowIcon = backButton.querySelector('svg')
      expect(arrowIcon).toBeInTheDocument()
    })
  })

  describe('User Interactions', () => {
    it('should call onBack when back button is clicked', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0]
      fireEvent.click(backButton)

      expect(mockOnBack).toHaveBeenCalledTimes(1)
    })

    it('should call onSkip when skip button is clicked', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(mockOnSkip).toHaveBeenCalledTimes(1)
    })

    it('should not call onBack when skip button is clicked', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(mockOnBack).not.toHaveBeenCalled()
    })

    it('should not call onSkip when back button is clicked', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0]
      fireEvent.click(backButton)

      expect(mockOnSkip).not.toHaveBeenCalled()
    })
  })

  describe('Accessibility', () => {
    it('should have proper button roles', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(2)
    })

    it('should be keyboard accessible', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0]
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      // Buttons should be focusable
      backButton.focus()
      expect(backButton).toHaveFocus()

      skipButton.focus()
      expect(skipButton).toHaveFocus()
    })

    it('should support keyboard navigation', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0]
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      // Test that buttons can be focused and activated
      backButton.focus()
      expect(backButton).toHaveFocus()

      skipButton.focus()
      expect(skipButton).toHaveFocus()

      // Test that buttons respond to clicks (which also work with keyboard)
      fireEvent.click(backButton)
      expect(mockOnBack).toHaveBeenCalledTimes(1)

      fireEvent.click(skipButton)
      expect(mockOnSkip).toHaveBeenCalledTimes(1)
    })
  })

  describe('Layout and Structure', () => {
    it('should have proper flex layout', () => {
      const { container } = render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper).toHaveClass('flex', 'items-center', 'justify-between', 'w-full')
    })

    it('should have responsive gap classes', () => {
      const { container } = render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const rightSection = container.querySelector('.flex.items-center.gap-2.sm\\:gap-3')
      expect(rightSection).toBeInTheDocument()
    })
  })

  describe('Edge Cases', () => {
    it('should handle multiple rapid clicks', () => {
      render(<OnboardingActionButtons onBack={mockOnBack} onSkip={mockOnSkip} />)

      const buttons = screen.getAllByRole('button')
      const backButton = buttons[0]
      const skipButton = screen.getByRole('button', { name: 'Skip' })

      // Rapid clicks
      fireEvent.click(backButton)
      fireEvent.click(backButton)
      fireEvent.click(skipButton)
      fireEvent.click(skipButton)

      expect(mockOnBack).toHaveBeenCalledTimes(2)
      expect(mockOnSkip).toHaveBeenCalledTimes(2)
    })

    it('should work with undefined callback functions', () => {
      // This should not throw errors
      expect(() => {
        render(<OnboardingActionButtons onBack={undefined as any} onSkip={undefined as any} />)
      }).not.toThrow()
    })
  })
})
