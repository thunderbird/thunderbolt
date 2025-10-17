import { useEffect, useState } from 'react'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
} from '@/components/ui/responsive-modal'
import { useBooleanSetting } from '@/hooks/use-setting'
import OnboardingStep1 from './onboarding-step-1'
import OnboardingStep2 from './onboarding-step-2'

export default function OnboardingDialog() {
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useBooleanSetting('user_has_completed_onboarding', false)
  const [currentStep, setCurrentStep] = useState(1)
  const [isOpen, setIsOpen] = useState(false)

  // Open dialog if not onboarded
  useEffect(() => {
    if (!hasCompletedOnboarding) {
      setIsOpen(true)
    }
  }, [hasCompletedOnboarding])

  const handleCompleteStep1 = () => {
    // Mark user as onboarded and move to step 2
    setHasCompletedOnboarding(true)
    setCurrentStep(2)
  }

  const handleBack = () => {
    setCurrentStep(1)
  }

  const handleClose = () => {
    setIsOpen(false)
  }

  const handleOpenChange = (open: boolean) => {
    // Only allow closing if we're on step 2 or later
    if (!open && currentStep >= 2) {
      setIsOpen(false)
    }
  }

  const getStepTitle = () => {
    switch (currentStep) {
      case 1:
        return 'Welcome to Thunderbolt'
      case 2:
        return 'Setup Complete'
      default:
        return 'Onboarding'
    }
  }

  const getStepDescription = () => {
    switch (currentStep) {
      case 1:
        return 'Tell us your name and location so we can personalize your AI assistant experience.'
      case 2:
        return "You're ready to start using Thunderbolt! Here are some tips to help you get started."
      default:
        return ''
    }
  }

  return (
    <ResponsiveModal open={isOpen} onOpenChange={handleOpenChange}>
      <ResponsiveModalContent className="sm:max-w-[500px] p-0">
        <ResponsiveModalHeader className="px-6 pt-6">
          <ResponsiveModalTitle>{getStepTitle()}</ResponsiveModalTitle>
          <ResponsiveModalDescription>{getStepDescription()}</ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="px-6 pb-6">
          {currentStep === 1 && <OnboardingStep1 onCompleteStep1={handleCompleteStep1} />}
          {currentStep === 2 && <OnboardingStep2 onBack={handleBack} onClose={handleClose} />}
        </div>
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
