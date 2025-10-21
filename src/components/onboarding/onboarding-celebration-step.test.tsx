import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getSettings } from '@/dal/settings'
import OnboardingCelebrationStep from './onboarding-celebration-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
})

describe('OnboardingCelebrationStep', () => {
  const defaultProps = {
    onComplete: mock(),
  }

  describe('UI rendering', () => {
    it('should render celebration UI correctly', () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      // Verify main heading
      expect(screen.getByText('All Set!')).toBeInTheDocument()
      expect(screen.getByText('Welcome to Thunderbolt! 🎉')).toBeInTheDocument()

      // Verify feature cards
      expect(screen.getByText("You're Ready to Go!")).toBeInTheDocument()
      expect(screen.getByText('Privacy Protected')).toBeInTheDocument()

      // Verify completion button
      expect(screen.getByRole('button', { name: 'Start Using Thunderbolt' })).toBeInTheDocument()
    })

    it('should render CheckCircle and Sparkles icons', () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      // Verify icons are present (check for SVG elements)
      const svgElements = document.querySelectorAll('svg')
      expect(svgElements.length).toBeGreaterThan(0)
    })
  })

  describe('User interactions', () => {
    it('should handle completion button click', async () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })

      // Click completion button
      fireEvent.click(completeButton)

      // Verify loading state
      await waitFor(() => {
        expect(screen.getByText('Completing...')).toBeInTheDocument()
      })

      // Wait for completion
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalled()
      })

      // Verify database persistence
      const settings = await getSettings({
        user_has_completed_onboarding: false,
        onboarding_current_step: '1',
      })

      expect(settings.userHasCompletedOnboarding).toBe(true)
      expect(settings.onboardingCurrentStep).toBe('1')
    })

    it('should call onComplete after successful completion', async () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })
      fireEvent.click(completeButton)

      // Wait for completion
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalled()
      })
    })
  })

  describe('Loading states', () => {
    it('should show loading state when completing', async () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })
      fireEvent.click(completeButton)

      // Verify loading state
      await waitFor(() => {
        expect(screen.getByText('Completing...')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Completing...' })).toBeDisabled()
      })
    })

    it('should disable button during completion', async () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })
      fireEvent.click(completeButton)

      // Verify button is disabled during completion
      await waitFor(() => {
        const loadingButton = screen.getByRole('button', { name: 'Completing...' })
        expect(loadingButton).toBeDisabled()
      })
    })
  })

  describe('Integration test', () => {
    it('should complete full onboarding flow with database persistence', async () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })
      fireEvent.click(completeButton)

      // Wait for completion
      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalled()
      })

      // Verify database persistence
      const settings = await getSettings({
        user_has_completed_onboarding: false,
        onboarding_current_step: '1',
      })

      expect(settings.userHasCompletedOnboarding).toBe(true)
      expect(settings.onboardingCurrentStep).toBe('1')
    })
  })

  describe('Accessibility', () => {
    it('should have proper button accessibility', () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      const completeButton = screen.getByRole('button', { name: 'Start Using Thunderbolt' })
      expect(completeButton).toBeInTheDocument()
      expect(completeButton).not.toBeDisabled()
    })

    it('should have proper heading structure', () => {
      render(<OnboardingCelebrationStep {...defaultProps} />, {
        wrapper: createQueryTestWrapper(),
      })

      // Verify heading structure
      expect(screen.getByRole('heading', { level: 2, name: 'All Set!' })).toBeInTheDocument()
    })
  })
})
