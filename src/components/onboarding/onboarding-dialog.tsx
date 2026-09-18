/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { Dialog, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useDatabase } from '@/contexts'
import { deleteIntegrationCredentials } from '@/dal'
import type { OAuthProvider } from '@/lib/auth'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '@/hooks/use-settings'
import { onboardingStepCount, useOnboardingState } from '@/hooks/use-onboarding-state'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { OnboardingNameStep } from './onboarding-name-step'
import { OnboardingLocationStep } from './onboarding-location-step'
import { OnboardingLanguageStep } from './onboarding-language-step'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { StepIndicators } from './step-indicators'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

export const OnboardingDialog = () => {
  const { isMobile } = useIsMobile()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const [isOpen, setIsOpen] = useState(false)
  const { state, actions } = useOnboardingState()

  // Owned here (the connected container) so the auth step stays presentational.
  const handleProviderDisconnect = async (provider: OAuthProvider) => {
    await deleteIntegrationCredentials(db, provider)
    await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
  }

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
    if (state.currentStep === onboardingStepCount) {
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

  const isCelebration = state.currentStep === onboardingStepCount

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
      <ResponsiveModalContentComposable
        className={cn('overflow-hidden p-0', !isMobile && 'h-[650px] max-h-[calc(100dvh-2rem)]')}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          <Trans>Onboarding Wizard</Trans>
        </DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Complete the setup process to get started with Thunderbolt</Trans>
        </DialogDescription>
        <div
          className={cn('flex h-full flex-col items-center', !isMobile && 'pb-6 pt-8')}
          style={isMobile ? { paddingBottom: 'var(--kb, 0px)' } : undefined}
        >
          <div className="relative flex w-full shrink-0 items-center justify-center px-4 pb-2">
            <StepIndicators currentStep={state.currentStep} totalSteps={onboardingStepCount} />
          </div>
          <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-4">
            {state.currentStep === 1 && <OnboardingPrivacyStep state={state} actions={actions} />}
            {state.currentStep === 2 && (
              <OnboardingAuthStep
                isProcessing={state.processingOAuth}
                isConnected={state.isProviderConnected}
                onConnectionChange={actions.setProviderConnected}
                onDisconnect={handleProviderDisconnect}
              />
            )}
            {state.currentStep === 3 && (
              <OnboardingNameStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />
            )}
            {state.currentStep === 4 && (
              <OnboardingLocationStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />
            )}
            {state.currentStep === 5 && <OnboardingLanguageStep />}
            {state.currentStep === 6 && <OnboardingCelebrationStep />}
          </div>
          <div className="relative flex w-full shrink-0 px-5 pt-2">
            <OnboardingActionButtons
              onBack={isCelebration ? undefined : state.canGoBack ? handleBackAction : undefined}
              onSkip={isCelebration ? undefined : state.canSkip ? handleSkipAction : undefined}
              onContinue={handleContinue}
              showBack={isCelebration ? false : state.canGoBack}
              showSkip={isCelebration ? false : state.canSkip}
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
                        : isCelebration && isCompleting
              }
              continueText={
                isCelebration ? (
                  isCompleting ? (
                    <Trans>Completing…</Trans>
                  ) : (
                    <Trans>Start Using Thunderbolt</Trans>
                  )
                ) : (
                  <Trans>Continue</Trans>
                )
              }
            />
          </div>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
