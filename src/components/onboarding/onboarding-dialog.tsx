/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useSettings } from '@/hooks/use-settings'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { OnboardingNameStep } from './onboarding-name-step'
import { OnboardingLocationStep } from './onboarding-location-step'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { OnboardingModelProviderStep } from './onboarding-model-provider-step'
import { OnboardingSearchProviderStep } from './onboarding-search-provider-step'
import { StepIndicators } from './step-indicators'
import { OnboardingActionButtons } from './onboarding-action-buttons'

/**
 * Full-screen onboarding step-router (spec-standalone §11). Replaces the old
 * modal wizard: the step sequence is derived from the trust domain (standalone
 * adds model/search provider steps; server skips them) by {@link useOnboardingFlow},
 * while per-step field logic still comes from {@link useOnboardingState}. Provider
 * steps are self-contained (own their connect/skip buttons); the shared steps use
 * the common action bar. Per-step persistence and the returning-user bypass are
 * preserved.
 */
export const OnboardingDialog = () => {
  const { userHasCompletedOnboarding } = useSettings({ user_has_completed_onboarding: false })
  const flow = useOnboardingFlow()
  const { state, actions } = useOnboardingState()

  const [isCompleting, setIsCompleting] = useState(false)
  const [isFormDirty, setIsFormDirty] = useState(false)

  const skipOnboarding = import.meta.env.VITE_SKIP_ONBOARDING === 'true'
  const isLoading = userHasCompletedOnboarding.isLoading || flow.isLoading
  const shouldShow = !skipOnboarding && !isLoading && !userHasCompletedOnboarding.value
  if (!shouldShow) {
    return null
  }

  const step = flow.currentStep

  const handleComplete = async () => {
    setIsCompleting(true)
    await flow.complete()
    setIsCompleting(false)
  }

  const handleContinue = async () => {
    if (step === 'celebration') {
      await handleComplete()
      return
    }
    if (step === 'name') {
      if (state.isNameValid && state.nameValue) {
        await actions.submitName(state.nameValue)
        await flow.goNext()
      }
      return
    }
    await flow.goNext()
  }

  const continueDisabled = (() => {
    if (step === 'privacy') {
      return !state.privacyAgreed
    }
    if (step === 'integrations') {
      return !state.isProviderConnected
    }
    if (step === 'name') {
      return !state.isNameValid
    }
    if (step === 'location') {
      return !state.isLocationValid
    }
    if (step === 'celebration') {
      return isCompleting
    }
    return false
  })()

  const isProviderStep = step === 'model-provider' || step === 'search-provider'

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center bg-background overflow-y-auto">
      <div
        className="flex flex-col items-center w-full max-w-[520px] flex-1"
        style={{
          paddingBottom: 'calc(var(--safe-area-bottom-padding) + 24px + var(--kb, 0px))',
          paddingTop: 'calc(var(--safe-area-top-padding) + 32px)',
        }}
      >
        <div className="flex items-center justify-center px-4 w-full pb-2">
          <StepIndicators currentStep={flow.stepNumber} totalSteps={flow.totalSteps} />
        </div>

        <div className="flex flex-1 flex-col w-full px-6 py-4">
          {step === 'model-provider' && <OnboardingModelProviderStep onComplete={flow.goNext} onSkip={flow.skip} />}
          {step === 'search-provider' && <OnboardingSearchProviderStep onComplete={flow.goNext} onSkip={flow.skip} />}
          {step === 'privacy' && <OnboardingPrivacyStep state={state} actions={actions} />}
          {step === 'integrations' && (
            <OnboardingAuthStep
              isProcessing={state.processingOAuth}
              isConnected={state.isProviderConnected}
              onConnectionChange={actions.setProviderConnected}
            />
          )}
          {step === 'name' && <OnboardingNameStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />}
          {step === 'location' && (
            <OnboardingLocationStep state={state} actions={actions} onFormDirtyChange={setIsFormDirty} />
          )}
          {step === 'celebration' && <OnboardingCelebrationStep />}
        </div>

        {!isProviderStep && (
          <div className="flex w-full px-5 pt-2">
            <OnboardingActionButtons
              onBack={flow.isFirstStep || step === 'celebration' ? undefined : flow.goBack}
              onSkip={step !== 'celebration' && flow.canSkip ? flow.skip : undefined}
              onContinue={handleContinue}
              showBack={!flow.isFirstStep && step !== 'celebration'}
              showSkip={step !== 'celebration' && flow.canSkip}
              skipDisabled={
                (step === 'integrations' && state.isProviderConnected) ||
                (step === 'name' && state.isNameValid) ||
                (step === 'location' && isFormDirty)
              }
              continueDisabled={continueDisabled}
              continueText={
                step === 'celebration' ? (isCompleting ? 'Completing...' : 'Start Using Thunderbolt') : 'Continue'
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}
