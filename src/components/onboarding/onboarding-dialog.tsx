/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { OnboardingNameStep } from './onboarding-name-step'
import { OnboardingLocationStep } from './onboarding-location-step'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { StepIndicators } from './step-indicators'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

export const OnboardingDialog = () => {
  const { isMobile } = useIsMobile()
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const [isOpen, setIsOpen] = useState(false)
  const { state, actions } = useOnboardingState()

  useEffect(() => {
    if (import.meta.env.VITE_SKIP_ONBOARDING === 'true') {
      return
    }
    if (!userHasCompletedOnboarding.isLoading && !userHasCompletedOnboarding.value) {
      setIsOpen(true)
    }
  }, [userHasCompletedOnboarding.value, userHasCompletedOnboarding.isLoading])

  const handleClose = () => {
    setIsOpen(false)
  }

  // Celebration step completion handler
  const [isCompleting, setIsCompleting] = useState(false)
  const [isFormDirty, setIsFormDirty] = useState(false)
  const { onboardingCurrentStep } = useSettings({
    onboarding_current_step: '1',
  })

  const handleCelebrationComplete = async () => {
    setIsCompleting(true)
    await Promise.all([userHasCompletedOnboarding.setValue(true), onboardingCurrentStep.setValue('1')])
    setIsCompleting(false)
    handleClose()
  }

  // Unified action handlers
  const handleContinue = async () => {
    if (state.currentStep === 5) {
      // Special handling for celebration step
      handleCelebrationComplete()
    } else if (state.currentStep === 2) {
      // Auth step - only allow continue if connected
      if (state.isProviderConnected) {
        actions.nextStep()
      }
    } else if (state.currentStep === 3) {
      // Name step - save name to database before proceeding
      if (state.isNameValid && state.nameValue) {
        try {
          await actions.submitName(state.nameValue)
          actions.nextStep()
        } catch (error) {
          console.error('Failed to save name:', error)
        }
      }
    } else if (state.canGoNext) {
      actions.nextStep()
    }
  }

  const handleBackAction = () => {
    if (state.canGoBack) {
      actions.prevStep()
    }
  }

  const handleSkipAction = () => {
    if (state.canSkip) {
      actions.skipStep()
    }
  }

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className={cn('p-0 overflow-hidden', !isMobile && 'h-[650px]')}
        style={{
          bottom: 'var(--kb, 0px)',
        }}
        showCloseButton={false}
        useTransparentOverlay={!isMobile}
        fullScreen={isMobile}
      >
        <DialogTitle className="sr-only">Onboarding Wizard</DialogTitle>
        <DialogDescription className="sr-only">
          Complete the setup process to get started with Thunderbolt
        </DialogDescription>
        <div
          className={cn('flex flex-col items-center', isMobile && 'h-dvh')}
          style={{
            paddingBottom: 'calc(var(--safe-area-bottom-padding) + 24px + var(--kb, 0px))',
            paddingTop: 'calc(var(--safe-area-top-padding) + 32px)',
          }}
        >
          <div className="flex items-center justify-center px-4 relative w-full pb-2">
            <StepIndicators currentStep={state.currentStep} totalSteps={5} />
            <div className="absolute -bottom-5.5 w-full h-6 bg-gradient-to-b from-background to-transparent" />
          </div>
          <div className="flex flex-1 flex-col px-6 overflow-scroll py-4">
            {state.currentStep === 1 && <OnboardingPrivacyStep state={state} actions={actions} />}
            {state.currentStep === 2 && (
              <OnboardingAuthStep
                isProcessing={state.processingOAuth}
                isConnected={state.isProviderConnected}
                onConnectionChange={actions.setProviderConnected}
              />
            )}
            {state.currentStep === 3 && (
              <OnboardingNameStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />
            )}
            {state.currentStep === 4 && (
              <OnboardingLocationStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />
            )}
            {state.currentStep === 5 && <OnboardingCelebrationStep />}
          </div>
          <div className="flex w-full px-5 pt-2 relative">
            <div className="absolute -top-5.5 w-full h-6 bg-gradient-to-b from-transparent to-background" />
            <OnboardingActionButtons
              onBack={state.currentStep === 5 ? undefined : state.canGoBack ? handleBackAction : undefined}
              onSkip={state.currentStep === 5 ? undefined : state.canSkip ? handleSkipAction : undefined}
              onContinue={handleContinue}
              showBack={state.currentStep === 5 ? false : state.canGoBack}
              showSkip={state.currentStep === 5 ? false : state.canSkip}
              skipDisabled={
                (state.currentStep === 2 && state.isProviderConnected) ||
                (state.currentStep === 3 && state.isNameValid) ||
                (state.currentStep === 4 && isFormDirty)
              }
              continueDisabled={
                state.currentStep === 1
                  ? !state.privacyAgreed
                  : state.currentStep === 2
                    ? !state.isProviderConnected
                    : state.currentStep === 3
                      ? !state.isNameValid
                      : state.currentStep === 4
                        ? !state.isLocationValid
                        : state.currentStep === 5
                          ? isCompleting
                          : true
              }
              continueText={
                state.currentStep === 5 ? (isCompleting ? 'Completing...' : 'Start Using Thunderbolt') : 'Continue'
              }
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
