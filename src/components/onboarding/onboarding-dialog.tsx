/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { lazy, Suspense, useEffect, useEffectEvent, useReducer, useState, useTransition } from 'react'
import { Dialog, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useDatabase, useSignInModal } from '@/contexts'
import { deleteIntegrationCredentials, updateSettings } from '@/dal'
import type { OAuthProvider } from '@/lib/auth'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '@/hooks/use-settings'
import { onboardingStepCount, useOnboardingState } from '@/hooks/use-onboarding-state'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { OnboardingAuthStep } from './onboarding-auth-step'
import { OnboardingNameStep } from './onboarding-name-step'
import { OnboardingLocationStep } from './onboarding-location-step'
import { OnboardingLanguageStep } from './onboarding-language-step'
import { OnboardingPasskeyStep } from './onboarding-passkey-step'
import { OnboardingCelebrationStep } from './onboarding-celebration-step'
import { useAccountPasskey } from '@/lib/passkey'
import { StepIndicators } from './step-indicators'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { OnboardingServerStep } from './onboarding-server-step'
import { useOnboardingServerState } from './use-onboarding-server-state'
import { OnboardingSearchStep } from './onboarding-search-step'
import { useOnboardingModelState } from './use-onboarding-model-state'
import { useNeedsOwnModel } from '@/hooks/use-needs-own-model'

// The provider catalog and connection probe load only when this step is opened.
const OnboardingModelStep = lazy(() => import('./onboarding-model-step'))

/** Wizard position of the passkey step. */
const passkeyStep = 6

export const OnboardingDialog = () => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const isStandalone = useNeedsOwnModel()
  const { openSignInModal } = useSignInModal()
  const serverState = useOnboardingServerState()
  const hasSearchProvider = useSearchProviderStore((state) => Boolean(state.provider && state.apiKey))
  const { configuredModels } = useOnboardingModelState()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { userHasCompletedOnboarding } = useSettings({
    user_has_completed_onboarding: false,
  })
  const hasBuiltInSearch = configuredModels.some((model) => model.provider === 'tinfoil' && model.toolUsage !== 0)
  const { state, actions, stepIndex, totalSteps } = useOnboardingState({ isStandalone, hasBuiltInSearch })
  // The account gets one passkey, so the step is offered only while it has none.
  const accountPasskey = useAccountPasskey()
  const shouldOfferPasskeyStep = accountPasskey.isSettled && !accountPasskey.isUnavailable && !accountPasskey.passkey

  /**
   * Derived during render rather than mirrored into state. The previous effect
   * only ever called `setIsOpen(true)`, so nothing closed the wizard when the
   * flag flipped to true — a device that learned it was already onboarded, via
   * sign-in or a sync download, kept it on screen (GH #1299).
   */
  const isOpen =
    import.meta.env.VITE_SKIP_ONBOARDING !== 'true' &&
    !userHasCompletedOnboarding.isLoading &&
    !userHasCompletedOnboarding.value

  // Skip the step when it isn't offered (no passkey support, or the account
  // already has one), but only once that's known: the skip is persisted, so
  // skipping while still loading would lose the step for good.
  const skipPasskeyStep = useEffectEvent(() => {
    actions.skipStep().catch((error) => console.error('Failed to skip the passkey step:', error))
  })
  useEffect(() => {
    if (isOpen && state.currentStep === passkeyStep && accountPasskey.isSettled && !shouldOfferPasskeyStep) {
      skipPasskeyStep()
    }
  }, [isOpen, state.currentStep, accountPasskey.isSettled, shouldOfferPasskeyStep])

  // Owned here (the connected container) so the auth step stays presentational.
  const handleProviderDisconnect = async (provider: OAuthProvider) => {
    await deleteIntegrationCredentials(db, provider)
    await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
  }

  // Celebration step completion handler
  const [isCompleting, startCompleting] = useTransition()
  const [{ isFormDirty, isSearchReady }, updateForm] = useReducer(
    (
      state: { isFormDirty: boolean; isSearchReady: boolean },
      patch: Partial<{ isFormDirty: boolean; isSearchReady: boolean }>,
    ) => ({ ...state, ...patch }),
    { isFormDirty: false, isSearchReady: hasSearchProvider },
  )
  const setIsFormDirty = (isFormDirty: boolean) => updateForm({ isFormDirty })
  const [completionError, setCompletionError] = useState<string | null>(null)

  const handleCelebrationComplete = () => {
    startCompleting(async () => {
      setCompletionError(null)
      try {
        await updateSettings(db, { user_has_completed_onboarding: true, onboarding_current_step: '1' })
        await queryClient.invalidateQueries({ queryKey: ['settings'] })
      } catch (error) {
        console.error('Failed to finish onboarding:', error)
        setCompletionError(t`Could not finish setup. Please try again.`)
      }
    })
  }

  // Unified action handlers
  const handleContinue = async () => {
    if (state.currentStep === 8) {
      serverState.continueSetup(actions.nextStep)
    } else if (state.currentStep === onboardingStepCount) {
      // Special handling for celebration step
      handleCelebrationComplete()
    } else if (state.currentStep === 10) {
      if (hasSearchProvider && isSearchReady) {
        await actions.nextStep()
      }
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
    if (state.currentStep === 10) {
      updateForm({ isSearchReady: hasSearchProvider })
    }
    if (state.currentStep === 8 && serverState.goBack()) {
      return
    }
    if (state.canGoBack) {
      actions.prevStep()
    }
  }

  const handleSkipAction = () => {
    if (state.currentStep === 10) {
      updateForm({ isSearchReady: hasSearchProvider })
    }
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
            <StepIndicators currentStep={stepIndex + 1} totalSteps={totalSteps} />
          </div>
          {state.currentStep === 9 ? (
            <Suspense fallback={<Loader2 className="size-6 animate-spin self-center text-muted-foreground" />}>
              <OnboardingModelStep onBack={handleBackAction} onContinue={actions.nextStep} onSkip={actions.skipStep} />
            </Suspense>
          ) : (
            <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-4">
              {state.currentStep === 1 && <OnboardingPrivacyStep state={state} actions={actions} />}
              {state.currentStep === 8 && (
                <OnboardingServerStep
                  serverState={serverState}
                  onSignIn={openSignInModal}
                  onContinueLocal={actions.nextStep}
                />
              )}
              {state.currentStep === 10 && (
                <OnboardingSearchStep onReadyChange={(isSearchReady) => updateForm({ isSearchReady })} />
              )}
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
              {state.currentStep === passkeyStep && !accountPasskey.isSettled && (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}
              {state.currentStep === passkeyStep && shouldOfferPasskeyStep && <OnboardingPasskeyStep />}
              {state.currentStep === onboardingStepCount && <OnboardingCelebrationStep />}
              {completionError && (
                <p role="alert" className="text-sm text-destructive">
                  {completionError}
                </p>
              )}
            </div>
          )}
          {state.currentStep !== 9 && (
            <div className="relative flex w-full shrink-0 px-5 pt-2">
              <OnboardingActionButtons
                onBack={isCelebration ? undefined : state.canGoBack ? handleBackAction : undefined}
                onSkip={isCelebration ? undefined : state.canSkip ? handleSkipAction : undefined}
                onContinue={handleContinue}
                showBack={isCelebration ? false : state.canGoBack}
                backDisabled={state.currentStep === 8 && serverState.isBusy}
                showSkip={isCelebration || state.currentStep === 8 ? false : state.canSkip}
                showContinue={state.currentStep !== 8 || serverState.isChoosingSetup}
                skipDisabled={
                  (state.currentStep === 2 && state.isProviderConnected) ||
                  (state.currentStep === 3 && state.isNameValid) ||
                  (state.currentStep === 4 && isFormDirty)
                }
                continueDisabled={
                  state.currentStep === 8
                    ? serverState.isBusy
                    : state.currentStep === 1
                      ? !state.privacyAgreed
                      : state.currentStep === 2
                        ? !state.isProviderConnected
                        : state.currentStep === 3
                          ? !state.isNameValid
                          : state.currentStep === 4
                            ? !state.isLocationValid
                            : state.currentStep === 10
                              ? !hasSearchProvider || !isSearchReady
                              : state.currentStep === passkeyStep
                                ? !accountPasskey.isSettled
                                : isCelebration && isCompleting
                }
                continueText={
                  state.currentStep === 8 && serverState.isConnecting ? (
                    <Trans>Connecting…</Trans>
                  ) : isCelebration && isCompleting ? (
                    <Trans>Completing…</Trans>
                  ) : (
                    <Trans>Continue</Trans>
                  )
                }
              />
            </div>
          )}
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
