import { render, screen, fireEvent } from '@testing-library/react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingLocationStep } from './onboarding-location-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock state and actions
const mockActions = {
  setLocationValue: vi.fn(),
  setLocationValid: vi.fn(),
  setSubmittingLocation: vi.fn(),
  submitLocation: vi.fn(),
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  skipStep: vi.fn(),
}

const mockState = {
  currentStep: 4 as const,
  privacyAgreed: true,
  isProviderConnected: true,
  isConnecting: false,
  processingOAuth: false,
  nameValue: 'John Doe',
  isNameValid: true,
  isSubmittingName: false,
  locationValue: '',
  isLocationValid: false,
  isSubmittingLocation: false,
  canGoBack: true,
  canGoNext: false,
  canSkip: true,
}

// Mock useLocationSearch hook
const mockLocationSearch = {
  open: false,
  setOpen: vi.fn(),
  searchQuery: '',
  setSearchQuery: vi.fn(),
  locations: [] as Array<{ name: string; coordinates: { lat: number; lng: number } }>,
  isSearching: false,
  clearSearch: vi.fn(),
}

vi.mock('@/hooks/use-location-search', () => ({
  useLocationSearch: () => mockLocationSearch,
}))

describe('OnboardingLocationStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await resetTestDatabase()
    vi.clearAllMocks()
  })

  const renderComponent = () => {
    return render(<OnboardingLocationStep state={mockState} actions={mockActions} />, {
      wrapper: createQueryTestWrapper(),
    })
  }

  describe('Component rendering', () => {
    it('should render location step UI correctly', () => {
      renderComponent()

      expect(screen.getByText('Where are you located?')).toBeInTheDocument()
      expect(
        screen.getByText('This helps us personalize your experience with local settings and features.'),
      ).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'Location' })).toBeInTheDocument()
      expect(screen.getByText('Select location...')).toBeInTheDocument()
    })

    it('should render MapPin icon', () => {
      renderComponent()

      // The MapPin icon is an SVG with aria-hidden="true", so we check the container
      const iconContainer = screen
        .getByText('Where are you located?')
        .closest('div')
        ?.parentElement?.querySelector('.mx-auto.w-16.h-16')
      expect(iconContainer).toBeInTheDocument()
      expect(iconContainer).toHaveClass('mx-auto', 'w-16', 'h-16', 'bg-primary/10', 'rounded-full')
    })
  })

  describe('Form interaction', () => {
    it('should open location search when combobox is clicked', () => {
      renderComponent()

      const combobox = screen.getByRole('combobox', { name: 'Location' })
      fireEvent.click(combobox)

      expect(mockLocationSearch.setOpen).toHaveBeenCalledWith(true)
    })

    it('should have proper form structure', () => {
      renderComponent()

      const form = document.querySelector('form')
      expect(form).toBeInTheDocument()
    })

    it('should have proper combobox structure', () => {
      renderComponent()

      const combobox = screen.getByRole('combobox', { name: 'Location' })
      expect(combobox).toBeInTheDocument()
      expect(combobox).toHaveAttribute('aria-expanded', 'false')
      expect(combobox).toHaveAttribute('aria-haspopup', 'dialog')
    })
  })

  describe('Accessibility', () => {
    it('should have proper form labels and structure', () => {
      renderComponent()

      expect(screen.getByLabelText('Location')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'Location' })).toBeInTheDocument()
    })

    it('should maintain accessibility during interactions', () => {
      renderComponent()

      const combobox = screen.getByRole('combobox', { name: 'Location' })
      fireEvent.click(combobox)

      expect(combobox).toBeInTheDocument()
      expect(combobox).toHaveAttribute('aria-expanded', 'false')
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid button clicks', () => {
      renderComponent()

      const combobox = screen.getByRole('combobox', { name: 'Location' })

      // Rapid clicks should not cause issues
      fireEvent.click(combobox)
      fireEvent.click(combobox)
      fireEvent.click(combobox)

      expect(mockLocationSearch.setOpen).toHaveBeenCalled()
    })

    it('should maintain accessibility during error states', () => {
      renderComponent()

      const combobox = screen.getByRole('combobox', { name: 'Location' })
      expect(combobox).toBeInTheDocument()
      expect(combobox).toHaveAttribute('aria-invalid', 'false')
    })
  })
})
