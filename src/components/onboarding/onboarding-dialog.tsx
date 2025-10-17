import { useEffect, useState } from 'react'
import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { useSettings } from '@/hooks/use-settings'
import OnboardingStep1 from './onboarding-step-1'
import OnboardingStep2 from './onboarding-step-2'

export default function OnboardingDialog() {
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const [currentStep, setCurrentStep] = useState(1)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (!userHasCompletedOnboarding.isLoading && !userHasCompletedOnboarding.value) {
      setIsOpen(true)
    }
  }, [userHasCompletedOnboarding.value, userHasCompletedOnboarding.isLoading])

  const handleCompleteStep1 = () => {
    userHasCompletedOnboarding.setValue(true)
    setCurrentStep(2)
  }

  const handleBack = () => {
    setCurrentStep(1)
  }

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
      <ResponsiveModalContent className="sm:max-w-[500px] p-0">
        <div className="px-6 pb-6 pt-5">
          {currentStep === 1 && <OnboardingStep1 onCompleteStep1={handleCompleteStep1} />}
          {currentStep === 2 && <OnboardingStep2 onBack={handleBack} onClose={handleClose} />}
        </div>
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
