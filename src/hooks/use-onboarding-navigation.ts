import { useState, useEffect } from 'react'
import { useSettings } from './use-settings'

const TOTAL_STEPS = 5
const FIRST_STEP = 1

type OnboardingNavigationReturn = {
  currentStep: number
  handleNext: () => void
  handleBack: () => void
  handleSkip: () => void
  canGoBack: boolean
  canGoNext: boolean
  isFirstStep: boolean
  isLastStep: boolean
}

/**
 * Custom hook for managing onboarding step navigation
 */
export const useOnboardingNavigation = (): OnboardingNavigationReturn => {
  const { onboardingCurrentStep } = useSettings({
    onboarding_current_step: '1',
  })

  const [currentStep, setCurrentStep] = useState(FIRST_STEP)

  useEffect(() => {
    const savedStep = parseInt(onboardingCurrentStep.value || '1', 10)
    if (savedStep >= FIRST_STEP && savedStep <= TOTAL_STEPS) {
      setCurrentStep(savedStep)
    }
  }, [onboardingCurrentStep.value])

  const handleNext = async () => {
    const newStep = Math.min(currentStep + 1, TOTAL_STEPS)
    setCurrentStep(newStep)
    await onboardingCurrentStep.setValue(String(newStep))
  }

  const handleBack = async () => {
    const newStep = Math.max(currentStep - 1, FIRST_STEP)
    setCurrentStep(newStep)
    await onboardingCurrentStep.setValue(String(newStep))
  }

  const handleSkip = async () => {
    const newStep = Math.min(currentStep + 1, TOTAL_STEPS)
    setCurrentStep(newStep)
    await onboardingCurrentStep.setValue(String(newStep))
  }

  const canGoBack = currentStep > FIRST_STEP
  const canGoNext = currentStep < TOTAL_STEPS
  const isFirstStep = currentStep === FIRST_STEP
  const isLastStep = currentStep === TOTAL_STEPS

  return {
    currentStep,
    handleNext,
    handleBack,
    handleSkip,
    canGoBack,
    canGoNext,
    isFirstStep,
    isLastStep,
  }
}

export { TOTAL_STEPS, FIRST_STEP }
