import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { act } from 'react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import OnboardingNameStep from './onboarding-name-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

describe('OnboardingNameStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  const defaultProps = {
    onNext: vi.fn(),
    onSkip: vi.fn(),
    onBack: vi.fn(),
  }

  describe('Component rendering', () => {
    it('should render name step UI correctly', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
      expect(screen.getByText('Your AI assistant will use this name to address you personally.')).toBeInTheDocument()
      expect(screen.getByText('Preferred Name')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter your name')).toBeInTheDocument()
    })

    it('should render User icon', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const userIcon = document.querySelector('.lucide-user')
      expect(userIcon).toBeInTheDocument()
    })

    it('should focus input on mount', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toHaveFocus()
    })
  })

  describe('Form validation', () => {
    it('should show validation error for empty name', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      // Clear input and try to submit
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.click(continueButton)

      await waitFor(() => {
        expect(screen.getByText('Name is required.')).toBeInTheDocument()
      })
    })

    it('should not show validation error for valid name', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: 'John Doe' } })
      fireEvent.click(continueButton)

      await waitFor(() => {
        expect(screen.queryByText('Name is required.')).not.toBeInTheDocument()
      })
    })
  })

  describe('Form submission', () => {
    it('should handle successful form submission', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: 'John Doe' } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })

    it('should handle form submission without existing name', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: 'Jane Smith' } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })
  })

  describe('Navigation', () => {
    it('should call onBack when back button is clicked', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const backButton = screen.getByRole('button', { name: /back/i })
      fireEvent.click(backButton)

      expect(defaultProps.onBack).toHaveBeenCalled()
    })

    it('should call onSkip when skip button is clicked', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const skipButton = screen.getByRole('button', { name: 'Skip' })
      fireEvent.click(skipButton)

      expect(defaultProps.onSkip).toHaveBeenCalled()
    })
  })

  describe('Accessibility', () => {
    it('should have proper form labels and structure', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const label = screen.getByText('Preferred Name')

      expect(input).toBeInTheDocument()
      expect(label).toBeInTheDocument()
    })

    it('should have proper heading structure', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading).toHaveTextContent('What should we call you?')
    })
  })

  describe('Integration with database', () => {
    it('should persist name data to database', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: 'John Doe' } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })
  })

  describe('Edge cases', () => {
    it('should handle very long names', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const longName = 'A'.repeat(1000)
      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: longName } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })

    it('should handle names with special characters', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const specialName = "José María O'Connor-Smith"
      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: specialName } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })
  })
})
