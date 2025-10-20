import { useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { OnboardingPrivacyStepWrapper } from './OnboardingPrivacyStepWrapper'
import { OnboardingAuthStepWrapper } from './OnboardingAuthStepWrapper'
import { OnboardingNameStepWrapper } from './OnboardingNameStepWrapper'
import { OnboardingLocationStepWrapper } from './OnboardingLocationStepWrapper'
import { OnboardingCelebrationStepWrapper } from './OnboardingCelebrationStepWrapper'
import { StepIndicators } from '@/components/onboarding/step-indicators'

const TOTAL_STEPS = 5

export const OnboardingDialogWrapper = () => {
  const [isOpen, setIsOpen] = useState(true)
  const [currentStep, setCurrentStep] = useState(1)

  const handleNext = () => {
    const newStep = Math.min(currentStep + 1, TOTAL_STEPS)
    setCurrentStep(newStep)
  }

  const handleBack = () => {
    const newStep = Math.max(currentStep - 1, 1)
    setCurrentStep(newStep)
  }

  const handleSkip = () => {
    const newStep = Math.min(currentStep + 1, TOTAL_STEPS)
    setCurrentStep(newStep)
  }

  const handleClose = () => {
    setIsOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[600px] sm:min-h-[500px] p-0 h-screen sm:h-auto w-screen sm:w-auto m-0 sm:m-4 rounded-none sm:rounded-lg max-h-screen overflow-hidden"
        showCloseButton={false}
      >
        <div className="h-full flex flex-col overflow-y-auto overflow-x-hidden">
          <div className="flex-1 px-6 py-6 flex flex-col justify-center min-h-0">
            <div className="w-full max-w-md mx-auto space-y-4 sm:min-h-[500px] sm:flex sm:flex-col sm:justify-center overflow-x-hidden">
              {currentStep === 1 && <OnboardingPrivacyStepWrapper onNext={handleNext} />}
              {currentStep === 2 && (
                <OnboardingAuthStepWrapper onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />
              )}
              {currentStep === 3 && (
                <OnboardingNameStepWrapper onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />
              )}
              {currentStep === 4 && (
                <OnboardingLocationStepWrapper onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />
              )}
              {currentStep === 5 && <OnboardingCelebrationStepWrapper onComplete={handleClose} />}
            </div>
          </div>

          <div className="px-6 pb-6 flex-shrink-0">
            <StepIndicators currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
