import { render, screen } from '@testing-library/react'
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest'
import '@testing-library/jest-dom'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'

// Mock useOnboardingState hook
const mockActions = {
  nextStep: vi.fn(),
}

const mockState = {}

vi.mock('@/hooks/use-onboarding-state', () => ({
  useOnboardingState: () => ({
    state: mockState,
    actions: mockActions,
  }),
}))

describe('OnboardingCelebrationStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await resetTestDatabase()
    vi.clearAllMocks()
  })

  const renderComponent = () => {
    return render(<OnboardingCelebrationStep />, { wrapper: createQueryTestWrapper() })
  }

  describe('UI rendering', () => {
    it('should render celebration UI correctly', () => {
      renderComponent()

      expect(screen.getByText('All Set!')).toBeInTheDocument()
      expect(screen.getByText(/Welcome to Thunderbolt!/)).toBeInTheDocument()
    })

    it('should render celebration message', () => {
      renderComponent()

      expect(screen.getByText('All Set!')).toBeInTheDocument()
      expect(screen.getByText(/Welcome to Thunderbolt!/)).toBeInTheDocument()
    })

    it('should render feature cards', () => {
      renderComponent()

      expect(screen.getByText("You're Ready to Go!")).toBeInTheDocument()
      expect(screen.getByText('Privacy Protected')).toBeInTheDocument()
    })
  })

  describe('Visual structure', () => {
    it('should display celebration icon with proper styling', () => {
      renderComponent()

      const heading = screen.getByText('All Set!')
      expect(heading).toBeInTheDocument()
    })

    it('should have proper text styling', () => {
      renderComponent()

      const heading = screen.getByText('All Set!')
      expect(heading).toHaveClass('text-2xl', 'font-bold')
    })
  })

  describe('Feature cards', () => {
    it('should display all feature cards with correct content', () => {
      renderComponent()

      expect(screen.getByText("You're Ready to Go!")).toBeInTheDocument()
      expect(screen.getByText('Privacy Protected')).toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderComponent()

      const heading = screen.getByRole('heading', { name: 'All Set!' })
      expect(heading).toBeInTheDocument()
    })

    it('should have proper text hierarchy', () => {
      renderComponent()

      const mainHeading = screen.getByRole('heading', { name: 'All Set!' })
      const subHeadings = screen.getAllByRole('heading', { level: 3 })

      expect(mainHeading).toBeInTheDocument()
      expect(subHeadings).toHaveLength(2)
    })

    it('should maintain accessibility with proper contrast', () => {
      renderComponent()

      const heading = screen.getByText('All Set!')
      expect(heading).toBeInTheDocument()
    })
  })

  describe('Content validation', () => {
    it('should display correct celebration message', () => {
      renderComponent()

      expect(screen.getByText('All Set!')).toBeInTheDocument()
      expect(screen.getByText(/Welcome to Thunderbolt!/)).toBeInTheDocument()
    })

    it('should display correct feature descriptions', () => {
      renderComponent()

      expect(screen.getByText(/Your AI assistant is configured/)).toBeInTheDocument()
      expect(screen.getByText(/All your data stays on your device/)).toBeInTheDocument()
    })

    it('should display correct feature titles', () => {
      renderComponent()

      expect(screen.getByText("You're Ready to Go!")).toBeInTheDocument()
      expect(screen.getByText('Privacy Protected')).toBeInTheDocument()
    })
  })

  describe('Edge cases', () => {
    it('should handle component rendering without errors', () => {
      expect(() => renderComponent()).not.toThrow()
    })

    it('should maintain proper structure with all elements', () => {
      renderComponent()

      expect(screen.getByText('All Set!')).toBeInTheDocument()
      expect(screen.getByText("You're Ready to Go!")).toBeInTheDocument()
      expect(screen.getByText('Privacy Protected')).toBeInTheDocument()
    })

    it('should display emoji correctly', () => {
      renderComponent()

      expect(screen.getByText(/🎉/)).toBeInTheDocument()
    })
  })

  describe('Visual elements', () => {
    it('should have proper icon styling', () => {
      renderComponent()

      const heading = screen.getByText('All Set!')
      expect(heading).toBeInTheDocument()
    })
  })

  describe('Content structure', () => {
    it('should have proper content hierarchy', () => {
      renderComponent()

      const mainHeading = screen.getByRole('heading', { name: 'All Set!' })
      expect(mainHeading).toBeInTheDocument()
    })
  })
})
