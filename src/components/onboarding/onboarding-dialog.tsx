import { useEffect, useState } from 'react'
import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { useSettings } from '@/hooks/use-settings'
import { useOnboardingNavigation, TOTAL_STEPS } from '@/hooks/use-onboarding-navigation'
import OnboardingStep1 from './onboarding-step-1'
import OnboardingStep2 from './onboarding-step-2'
import OnboardingStep3 from './onboarding-step-3'
import OnboardingStep4 from './onboarding-step-4'
import { StepIndicators } from './step-indicators'

export default function OnboardingDialog() {
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const [isOpen, setIsOpen] = useState(false)
  const { currentStep, handleNext, handleBack, handleSkip, isFirstStep } = useOnboardingNavigation()

  useEffect(() => {
    if (!userHasCompletedOnboarding.isLoading && !userHasCompletedOnboarding.value) {
      setIsOpen(true)
    }
  }, [userHasCompletedOnboarding.value, userHasCompletedOnboarding.isLoading])

  const handleClose = () => {
    setIsOpen(false)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && currentStep >= 2) {
      setIsOpen(false)
    }
  }

  return (
    <ResponsiveModal open={isOpen} onOpenChange={handleOpenChange}>
      <ResponsiveModalContent className={`sm:max-w-[500px] p-0 ${isFirstStep ? '[&>button]:hidden' : ''}`}>
        <div className="px-6 pb-6 pt-6">
          {currentStep === 1 && <OnboardingStep1 onNext={handleNext} />}
          {currentStep === 2 && <OnboardingStep2 onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />}
          {currentStep === 3 && <OnboardingStep3 onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />}
          {currentStep === 4 && <OnboardingStep4 onComplete={handleClose} onBack={handleBack} />}
        </div>

        <StepIndicators currentStep={currentStep} totalSteps={TOTAL_STEPS} />
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
