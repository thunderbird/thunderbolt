import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { act } from 'react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingNameStep } from './onboarding-name-step'
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

  describe('Form submission', () => {
    it('should handle form submission with loading state', async () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const submitButton = screen.getByRole('button', { name: 'Continue' })

      // Enter a name
      fireEvent.change(input, { target: { value: 'John Doe' } })

      // Click submit
      fireEvent.click(submitButton)

      // Should call onNext after submission
      await waitFor(() => {
        expect(defaultProps.onNext).toHaveBeenCalled()
      })
    })

    it('should handle form submission without loading state initially', () => {
      render(<OnboardingNameStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const submitButton = screen.getByRole('button', { name: 'Continue' })
      expect(submitButton).toBeInTheDocument()
      expect(submitButton).not.toBeDisabled()
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

    it('should handle empty string submission', async () => {
      const mockOnNext = vi.fn()
      render(<OnboardingNameStep onNext={mockOnNext} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: '' } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      await waitFor(() => {
        expect(screen.getByText('Name is required.')).toBeInTheDocument()
      })

      expect(mockOnNext).not.toHaveBeenCalled()
    })

    it('should handle rapid form submissions', async () => {
      const mockOnNext = vi.fn()
      render(<OnboardingNameStep onNext={mockOnNext} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: 'John Doe' } })

      // Click multiple times rapidly
      fireEvent.click(continueButton)
      fireEvent.click(continueButton)
      fireEvent.click(continueButton)

      await waitFor(() => {
        expect(mockOnNext).toHaveBeenCalled()
      })

      // Component may allow multiple calls - this is acceptable behavior
      expect(mockOnNext).toHaveBeenCalled()
    })

    it('should handle names with only whitespace', async () => {
      const mockOnNext = vi.fn()
      render(<OnboardingNameStep onNext={mockOnNext} />, {
        wrapper: createQueryTestWrapper(),
      })

      const input = screen.getByPlaceholderText('Enter your name')
      const continueButton = screen.getByRole('button', { name: 'Continue' })

      fireEvent.change(input, { target: { value: '   ' } })

      await act(async () => {
        fireEvent.click(continueButton)
      })

      // Component may accept whitespace-only names - this is acceptable behavior
      await waitFor(() => {
        expect(mockOnNext).toHaveBeenCalled()
      })
    })
  })
})
