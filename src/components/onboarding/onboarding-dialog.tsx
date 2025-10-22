import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'
import { useOnboardingNavigation, TOTAL_STEPS } from '@/hooks/use-onboarding-navigation'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { OnboardingNameStep } from './onboarding-name-step'
import { OnboardingLocationStep } from './onboarding-location-step'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { StepIndicators } from './step-indicators'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { useLocation, useNavigate } from 'react-router'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'

type LocationState = {
  oauth?: {
    code?: string
    state?: string
    error?: string
  }
}

export const OnboardingDialog = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const [isOpen, setIsOpen] = useState(false)
  const { currentStep, handleNext, handleBack, handleSkip } = useOnboardingNavigation()
  const [processingOAuth, setProcessingOAuth] = useState(false)

  const { processCallback } = useOAuthConnect({
    onSuccess: handleNext,
    setPreferredName: true,
    returnContext: 'onboarding',
  })

  useEffect(() => {
    if (!userHasCompletedOnboarding.isLoading && !userHasCompletedOnboarding.value) {
      setIsOpen(true)
    }
  }, [userHasCompletedOnboarding.value, userHasCompletedOnboarding.isLoading])

  // Handle OAuth callback when navigated back from /oauth/callback
  useEffect(() => {
    const state = location.state as LocationState | null
    const oauth = state?.oauth
    if (!oauth || processingOAuth) return

    const handleCallback = async () => {
      setProcessingOAuth(true)

      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        setProcessingOAuth(false)
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const handleClose = () => {
    setIsOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-[600px] p-0 h-[650px] w-[600px] m-4 rounded-lg overflow-hidden sm:h-[650px] sm:w-[600px] h-screen w-full m-0 rounded-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Onboarding Wizard</DialogTitle>
        <div className="h-full flex flex-col">
          <div className="px-4 sm:px-6 pt-4 sm:pt-6 flex-shrink-0">
            {currentStep > 1 && currentStep < 5 && <OnboardingActionButtons onBack={handleBack} onSkip={handleSkip} />}
          </div>
          <div className="flex-1 px-4 sm:px-6 flex items-center justify-center">
            <div className="w-full max-w-md h-[400px] sm:h-[500px] flex items-center justify-center">
              {currentStep === 1 && <OnboardingPrivacyStep onNext={handleNext} />}
              {currentStep === 2 && <OnboardingAuthStep onNext={handleNext} isProcessing={processingOAuth} />}
              {currentStep === 3 && <OnboardingNameStep onNext={handleNext} />}
              {currentStep === 4 && <OnboardingLocationStep onNext={handleNext} />}
              {currentStep === 5 && <OnboardingCelebrationStep onComplete={handleClose} />}
            </div>
          </div>
          <div className="px-4 sm:px-6 pb-4 sm:pb-6">
            <StepIndicators currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
