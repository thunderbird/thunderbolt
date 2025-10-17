import { useState } from 'react'

const TOTAL_STEPS = 4
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
  const [currentStep, setCurrentStep] = useState(FIRST_STEP)

  const handleNext = () => {
    setCurrentStep((prev) => Math.min(prev + 1, TOTAL_STEPS))
  }

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, FIRST_STEP))
  }

  const handleSkip = () => {
    setCurrentStep((prev) => Math.min(prev + 1, TOTAL_STEPS))
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
