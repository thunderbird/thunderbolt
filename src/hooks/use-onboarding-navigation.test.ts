import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getSettings } from '@/dal/settings'
import { useOnboardingNavigation } from './use-onboarding-navigation'
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

describe('useOnboardingNavigation', () => {
  describe('Initial state', () => {
    it('should initialize with first step', () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.currentStep).toBe(1)
      expect(result.current.canGoBack).toBe(false)
      expect(result.current.canGoNext).toBe(true)
      expect(result.current.isFirstStep).toBe(true)
      expect(result.current.isLastStep).toBe(false)
    })

    it('should provide navigation functions', () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(typeof result.current.handleNext).toBe('function')
      expect(typeof result.current.handleBack).toBe('function')
      expect(typeof result.current.handleSkip).toBe('function')
    })
  })

  describe('Navigation', () => {
    it('should handle next navigation', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Initial state
      expect(result.current.currentStep).toBe(1)
      expect(result.current.canGoNext).toBe(true)

      // Navigate to next step
      await act(async () => {
        await result.current.handleNext()
      })

      expect(result.current.currentStep).toBe(2)
      expect(result.current.canGoBack).toBe(true)
      expect(result.current.canGoNext).toBe(true)
      expect(result.current.isFirstStep).toBe(false)
      expect(result.current.isLastStep).toBe(false)

      // Verify database persistence
      const settings = await getSettings({
        onboarding_current_step: '1',
      })
      expect(settings.onboardingCurrentStep).toBe('2')
    })

    it('should handle back navigation', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Navigate to step 2 first
      await act(async () => {
        await result.current.handleNext()
      })

      expect(result.current.currentStep).toBe(2)
      expect(result.current.canGoBack).toBe(true)

      // Navigate back
      await act(async () => {
        await result.current.handleBack()
      })

      expect(result.current.currentStep).toBe(1)
      expect(result.current.canGoBack).toBe(false)
      expect(result.current.canGoNext).toBe(true)
      expect(result.current.isFirstStep).toBe(true)
      expect(result.current.isLastStep).toBe(false)

      // Verify database persistence
      const settings = await getSettings({
        onboarding_current_step: '1',
      })
      expect(settings.onboardingCurrentStep).toBe('1')
    })

    it('should handle skip navigation', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Initial state
      expect(result.current.currentStep).toBe(1)

      // Skip to next step
      await act(async () => {
        await result.current.handleSkip()
      })

      expect(result.current.currentStep).toBe(2)
      expect(result.current.canGoBack).toBe(true)
      expect(result.current.canGoNext).toBe(true)

      // Verify database persistence
      const settings = await getSettings({
        onboarding_current_step: '1',
      })
      expect(settings.onboardingCurrentStep).toBe('2')
    })
  })

  describe('Boundary conditions', () => {
    it('should not go below first step', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Try to go back from first step
      await act(async () => {
        await result.current.handleBack()
      })

      expect(result.current.currentStep).toBe(1)
      expect(result.current.canGoBack).toBe(false)
      expect(result.current.isFirstStep).toBe(true)
    })

    it('should not go above last step', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Navigate to last step (4 steps forward from step 1)
      await act(async () => {
        await result.current.handleNext() // 1 -> 2
      })
      await act(async () => {
        await result.current.handleNext() // 2 -> 3
      })
      await act(async () => {
        await result.current.handleNext() // 3 -> 4
      })
      await act(async () => {
        await result.current.handleNext() // 4 -> 5
      })

      // Wait for state to settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(result.current.currentStep).toBe(5)
      expect(result.current.canGoNext).toBe(false)
      expect(result.current.isLastStep).toBe(true)

      // Try to go beyond last step
      await act(async () => {
        await result.current.handleNext()
      })

      // Wait for state to settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(result.current.currentStep).toBe(5)
      expect(result.current.canGoNext).toBe(false)
      expect(result.current.isLastStep).toBe(true)
    })
  })

  describe('Database integration', () => {
    it('should persist step changes to database', async () => {
      const { result } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Navigate through steps
      const steps = [2, 3, 4, 5]

      for (const expectedStep of steps) {
        await act(async () => {
          await result.current.handleNext()
        })

        // Verify database persistence
        const settings = await getSettings({
          onboarding_current_step: '1',
        })
        expect(settings.onboardingCurrentStep).toBe(String(expectedStep))
      }
    })

    it('should load saved step from database', async () => {
      // Set initial step in database
      const { result: initialResult } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Navigate to step 3
      await act(async () => {
        await initialResult.current.handleNext()
      })
      await act(async () => {
        await initialResult.current.handleNext()
      })

      // Verify step 3 is saved
      const settings = await getSettings({
        onboarding_current_step: '1',
      })
      expect(settings.onboardingCurrentStep).toBe('3')

      // Create new hook instance (simulating page reload)
      const { result: newResult } = renderHook(() => useOnboardingNavigation(), {
        wrapper: createQueryTestWrapper(),
      })

      // Wait for the useEffect to load the saved step
      await act(async () => {
        // Wait for the effect to run
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      // Should load step 3 from database
      expect(newResult.current.currentStep).toBe(3)
      expect(newResult.current.canGoBack).toBe(true)
      expect(newResult.current.canGoNext).toBe(true)
    })
  })
})
