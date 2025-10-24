import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingNameStep } from './onboarding-name-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock state and actions
const mockActions = {
  setNameValue: vi.fn(),
  setNameValid: vi.fn(),
  setSubmittingName: vi.fn(),
  submitName: vi.fn(),
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  skipStep: vi.fn(),
}

const mockState = {
  currentStep: 3 as const,
  privacyAgreed: true,
  isProviderConnected: true,
  isConnecting: false,
  processingOAuth: false,
  nameValue: '',
  isNameValid: false,
  isSubmittingName: false,
  locationValue: '',
  isLocationValid: false,
  isSubmittingLocation: false,
  canGoBack: true,
  canGoNext: true,
  canSkip: false,
}

describe('OnboardingNameStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await resetTestDatabase()
    vi.clearAllMocks()
  })

  const renderComponent = () => {
    return render(<OnboardingNameStep state={mockState} actions={mockActions} />, { wrapper: createQueryTestWrapper() })
  }

  describe('Component rendering', () => {
    it('should render name step UI correctly', () => {
      renderComponent()

      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
      expect(screen.getByText('Your AI assistant will use this name to address you personally.')).toBeInTheDocument()
      expect(screen.getByLabelText('Preferred Name')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter your name')).toBeInTheDocument()
    })

    it('should render User icon container', () => {
      renderComponent()

      // The User icon is an SVG with aria-hidden="true", so we check the container
      const iconContainer = screen
        .getByText('What should we call you?')
        .closest('div')
        ?.parentElement?.querySelector('.mx-auto.w-16.h-16')
      expect(iconContainer).toBeInTheDocument()
      expect(iconContainer).toHaveClass('mx-auto', 'w-16', 'h-16', 'bg-primary/10', 'rounded-full')
    })

    it('should focus input on mount', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toHaveFocus()
    })
  })

  describe('Form interaction', () => {
    it('should handle input changes', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John Doe' } })

      await waitFor(() => {
        expect(input).toHaveValue('John Doe')
      })
    })

    it('should handle empty input', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: '' } })

      await waitFor(() => {
        expect(input).toHaveValue('')
      })
    })

    it('should handle special characters in input', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const specialName = "José María O'Connor-Smith"
      fireEvent.change(input, { target: { value: specialName } })

      await waitFor(() => {
        expect(input).toHaveValue(specialName)
      })
    })

    it('should handle very long names', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const longName = 'A'.repeat(1000)
      fireEvent.change(input, { target: { value: longName } })

      await waitFor(() => {
        expect(input).toHaveValue(longName)
      })
    })
  })

  describe('Form structure', () => {
    it('should have proper input structure', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toBeInTheDocument()
      expect(input).toHaveAttribute('name', 'preferredName')
      expect(input).toHaveAttribute('placeholder', 'Enter your name')
    })

    it('should have proper label structure', () => {
      renderComponent()

      const label = screen.getByText('Preferred Name')
      expect(label).toBeInTheDocument()
      expect(label).toHaveAttribute('for')
    })
  })

  describe('Accessibility', () => {
    it('should have proper form labels and structure', () => {
      renderComponent()

      const input = screen.getByLabelText('Preferred Name')
      expect(input).toBeInTheDocument()
      expect(input).toHaveAttribute('placeholder', 'Enter your name')
    })

    it('should maintain accessibility during interactions', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).not.toBeDisabled()

      fireEvent.change(input, { target: { value: 'John Doe' } })
      expect(input).not.toBeDisabled()
    })

    it('should support keyboard navigation', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toHaveFocus()
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid input changes', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')

      // Rapid changes
      fireEvent.change(input, { target: { value: 'John' } })
      fireEvent.change(input, { target: { value: 'Jane' } })
      fireEvent.change(input, { target: { value: 'Bob' } })

      await waitFor(() => {
        expect(input).toHaveValue('Bob')
      })
    })

    it('should handle whitespace-only input', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: '   ' } })

      await waitFor(() => {
        expect(input).toHaveValue('   ')
      })
    })

    it('should handle input with newlines', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const nameWithNewlines = 'John\nDoe'
      fireEvent.change(input, { target: { value: nameWithNewlines } })

      await waitFor(() => {
        // Input fields strip newlines, so we expect the value without newlines
        expect(input).toHaveValue('JohnDoe')
      })
    })

    it('should handle input with tabs', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const nameWithTabs = 'John\tDoe'
      fireEvent.change(input, { target: { value: nameWithTabs } })

      await waitFor(() => {
        expect(input).toHaveValue(nameWithTabs)
      })
    })
  })

  describe('Component layout', () => {
    it('should have proper layout structure', () => {
      renderComponent()

      // Find the main container div
      const container = screen.getByText('What should we call you?').closest('div')?.parentElement
      expect(container).toHaveClass('w-full', 'h-full', 'flex', 'flex-col', 'justify-center')
    })

    it('should have proper text hierarchy', () => {
      renderComponent()

      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading).toHaveTextContent('What should we call you?')

      const description = screen.getByText('Your AI assistant will use this name to address you personally.')
      expect(description).toBeInTheDocument()
    })

    it('should have proper icon container styling', () => {
      renderComponent()

      const iconContainer = screen
        .getByText('What should we call you?')
        .closest('div')
        ?.parentElement?.querySelector('.mx-auto.w-16.h-16')
      expect(iconContainer).toHaveClass(
        'mx-auto',
        'w-16',
        'h-16',
        'bg-primary/10',
        'rounded-full',
        'flex',
        'items-center',
        'justify-center',
      )
    })
  })
})
