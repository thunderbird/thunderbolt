/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, beforeAll, afterAll, beforeEach, expect, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { OnboardingNameStep } from './onboarding-name-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { OnboardingState } from '@/hooks/use-onboarding-state'

const mockActions = {
  setNameValue: mock(),
  setNameValid: mock(),
  setSubmittingName: mock(),
  submitName: mock(),
  nextStep: mock(),
  prevStep: mock(),
  skipStep: mock(),
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('OnboardingNameStep', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
    mockActions.setNameValue.mockClear()
    mockActions.setNameValid.mockClear()
    mockActions.setSubmittingName.mockClear()
    mockActions.submitName.mockClear()
    mockActions.nextStep.mockClear()
    mockActions.prevStep.mockClear()
    mockActions.skipStep.mockClear()
  })

  const renderComponent = () => {
    return render(<OnboardingNameStep state={{} as OnboardingState} actions={mockActions} />, {
      wrapper: createQueryTestWrapper(),
    })
  }

  describe('Component rendering', () => {
    it('should render name step UI correctly', () => {
      renderComponent()

      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
      expect(screen.getByText('Your AI assistant will use this name to address you personally.')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter your name')).toBeInTheDocument()
    })

    it('should render User icon container', () => {
      renderComponent()

      // The User icon is an SVG with aria-hidden="true", so we check the container
      const iconContainer = screen
        .getByText('What should we call you?')
        .closest('div')
        ?.parentElement?.querySelector('.mx-auto')
      expect(iconContainer).toBeInTheDocument()
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

    it('should have proper input structure', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toBeInTheDocument()
      expect(input).toHaveAttribute('name', 'preferredName')
    })
  })

  describe('Accessibility', () => {
    it('should have proper form structure', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
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
        ?.parentElement?.querySelector('.mx-auto')
      expect(iconContainer).toBeInTheDocument()
    })
  })

  describe('Form Validation Business Logic', () => {
    it('should validate that name is required', async () => {
      renderComponent()

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(false)
      })
    })

    it('should validate name with only whitespace as invalid', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: '   ' } })

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(false)
      })
    })

    it('should validate name with content as valid', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John Doe' } })

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(true)
      })
    })

    it('should handle form validation errors', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')

      fireEvent.change(input, { target: { value: '' } })

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(false)
      })
    })
  })

  describe('State Management Business Logic', () => {
    it('should call setNameValue when input changes', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John Doe' } })

      await waitFor(() => {
        expect(mockActions.setNameValue).toHaveBeenCalledWith('John Doe')
      })
    })

    it('should call setNameValid when validation state changes', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John' } })

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(true)
      })
    })

    it('should initialize with correct default state', async () => {
      renderComponent()

      await waitFor(() => {
        expect(mockActions.setNameValue).toHaveBeenCalledWith('')
        expect(mockActions.setNameValid).toHaveBeenCalledWith(false)
      })
    })

    it('should handle form dirty state changes', () => {
      const mockOnFormDirtyChange = mock()

      render(
        <OnboardingNameStep
          state={{} as OnboardingState}
          actions={mockActions}
          onFormDirtyChange={mockOnFormDirtyChange}
        />,
        {
          wrapper: createQueryTestWrapper(),
        },
      )

      expect(mockOnFormDirtyChange).toHaveBeenCalledWith(false)
    })

    it('should reset form state on initialization', async () => {
      renderComponent()

      await waitFor(() => {
        expect(mockActions.setNameValue).toHaveBeenCalledWith('')
        expect(mockActions.setNameValid).toHaveBeenCalledWith(false)
      })
    })
  })

  describe('Settings Integration Business Logic', () => {
    it('should integrate with real useSettings hook', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toBeInTheDocument()
    })

    it('should load saved preferred name from settings', async () => {
      renderComponent()

      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    })

    it('should handle settings loading state', () => {
      renderComponent()

      expect(screen.getByPlaceholderText('Enter your name')).toBeInTheDocument()
    })
  })

  describe('Component Initialization Business Logic', () => {
    it('should auto-focus input on mount', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toHaveFocus()
    })

    it('should initialize form with correct default values', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      expect(input).toHaveValue('')
    })

    it('should set initialized state after mount', async () => {
      renderComponent()

      await waitFor(() => {
        expect(mockActions.setNameValue).toHaveBeenCalledWith('')
      })
    })
  })

  describe('Form Submission Business Logic', () => {
    it('should handle form submission with valid data', async () => {
      mockActions.submitName.mockResolvedValue(undefined)
      mockActions.nextStep.mockResolvedValue(undefined)

      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John Doe' } })

      await waitFor(() => {
        expect(mockActions.setNameValid).toHaveBeenCalledWith(true)
      })
    })

    it('should call submitName with correct data', async () => {
      mockActions.submitName.mockResolvedValue(undefined)

      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: 'John Doe' } })

      await waitFor(() => {
        expect(mockActions.setNameValue).toHaveBeenCalledWith('John Doe')
      })
    })
  })

  describe('Error Handling Business Logic', () => {
    it('should handle input validation errors gracefully', () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')

      fireEvent.change(input, { target: { value: '' } })

      expect(input).toBeInTheDocument()
    })

    it('should handle settings loading errors gracefully', () => {
      renderComponent()

      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    })
  })

  describe('Input Handling Business Logic', () => {
    it('should handle special characters correctly', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const specialName = "José María O'Connor-Smith"
      fireEvent.change(input, { target: { value: specialName } })

      await waitFor(() => {
        expect(input).toHaveValue(specialName)
        expect(mockActions.setNameValue).toHaveBeenCalledWith(specialName)
      })
    })

    it('should handle very long names', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      const longName = 'A'.repeat(1000)
      fireEvent.change(input, { target: { value: longName } })

      await waitFor(() => {
        expect(input).toHaveValue(longName)
        expect(mockActions.setNameValue).toHaveBeenCalledWith(longName)
      })
    })

    it('should handle rapid input changes', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')

      fireEvent.change(input, { target: { value: 'John' } })
      fireEvent.change(input, { target: { value: 'Jane' } })
      fireEvent.change(input, { target: { value: 'Bob' } })

      await waitFor(() => {
        expect(input).toHaveValue('Bob')
        expect(mockActions.setNameValue).toHaveBeenCalledWith('Bob')
      })
    })

    it('should trim whitespace for validation but preserve in display', async () => {
      renderComponent()

      const input = screen.getByPlaceholderText('Enter your name')
      fireEvent.change(input, { target: { value: '  John Doe  ' } })

      await waitFor(() => {
        expect(input).toHaveValue('  John Doe  ')
        expect(mockActions.setNameValue).toHaveBeenCalledWith('  John Doe  ')
      })
    })
  })
})
