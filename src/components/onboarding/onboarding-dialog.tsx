import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'
import { useOnboardingNavigation, TOTAL_STEPS } from '@/hooks/use-onboarding-navigation'
import OnboardingPrivacyStep from './onboarding-privacy-step'
import OnboardingAuthStep from './onboarding-auth-step'
import OnboardingNameStep from './onboarding-name-step'
import OnboardingLocationStep from './onboarding-location-step'
import OnboardingCelebrationStep from './onboarding-celebration-step'
import { StepIndicators } from './step-indicators'
import { useLocation, useNavigate } from 'react-router'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'

type LocationState = {
  oauth?: {
    code?: string
    state?: string
    error?: string
  }
}

export default function OnboardingDialog() {
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
        className="sm:max-w-[600px] sm:min-h-[500px] p-0 h-screen sm:h-auto w-screen sm:w-auto m-0 sm:m-4 rounded-none sm:rounded-lg max-h-screen overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Onboarding Wizard</DialogTitle>
        <div className="h-full flex flex-col overflow-y-auto overflow-x-hidden">
          <div className="flex-1 px-6 py-6 flex flex-col justify-center min-h-0">
            <div className="w-full max-w-md mx-auto space-y-4 sm:min-h-[500px] sm:flex sm:flex-col sm:justify-center overflow-x-hidden">
              {currentStep === 1 && <OnboardingPrivacyStep onNext={handleNext} />}
              {currentStep === 2 && (
                <OnboardingAuthStep
                  onNext={handleNext}
                  onSkip={handleSkip}
                  onBack={handleBack}
                  isProcessing={processingOAuth}
                />
              )}
              {currentStep === 3 && <OnboardingNameStep onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />}
              {currentStep === 4 && (
                <OnboardingLocationStep onNext={handleNext} onSkip={handleSkip} onBack={handleBack} />
              )}
              {currentStep === 5 && <OnboardingCelebrationStep onComplete={handleClose} />}
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
