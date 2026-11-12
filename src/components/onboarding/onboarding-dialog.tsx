/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAppName } from '@/lib/branding-selectors'
import { Trans, useLingui } from '@lingui/react/macro'
import { lazy, Suspense, useEffect, useEffectEvent, useState, useTransition } from 'react'
import { Dialog, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useDatabase, useSignInModal } from '@/contexts'
import { deleteIntegrationCredentials } from '@/dal'
import type { OAuthProvider } from '@/lib/auth'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { OnboardingServerStep } from './onboarding-server-step'
import { useOnboardingServerState } from './use-onboarding-server-state'
import { useNeedsOwnModel } from '@/hooks/use-needs-own-model'
import { preloadInBackground } from '@/lib/after-paint'

/** Share the AI setup bundle between lazy rendering and background preloading. */
const loadOnboardingModelStep = () => import('./onboarding-model-step')
const OnboardingModelStep = lazy(loadOnboardingModelStep)
/** Keep provider forms and OAuth SDKs off the initial sign-in and returning-chat paths. */
const loadOnboardingSearchStep = async () => {
  const { OnboardingSearchStep } = await import('./onboarding-search-step')
  return { default: OnboardingSearchStep }
}
const OnboardingSearchStep = lazy(loadOnboardingSearchStep)

/** Wizard position of the passkey step. */
const passkeyStep = 6

export const OnboardingDialog = () => {
  const { isMobile } = useIsMobile()
  const { userHasCompletedOnboarding } = useSettings({ user_has_completed_onboarding: false })
  const isOpen =
    import.meta.env.VITE_SKIP_ONBOARDING !== 'true' &&
    !userHasCompletedOnboarding.isLoading &&
    !userHasCompletedOnboarding.value
  return (
    <Dialog open={isOpen}>
      <ResponsiveModalContentComposable
        className={cn('overflow-hidden p-0', !isMobile && 'h-[650px] max-h-[calc(100dvh-2rem)]')}
        showCloseButton={false}
      >
        {/* Keep wizard queries unmounted until the dialog is shown. */}
        <OnboardingWizard isOpen={isOpen} isMobile={isMobile} />
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}

const OnboardingWizard = ({ isOpen, isMobile }: { isOpen: boolean; isMobile: boolean }) => {
  const { t } = useLingui()
  const appName = useAppName()
  const isStandalone = useNeedsOwnModel()
  const { openSignInModal } = useSignInModal()
  const serverState = useOnboardingServerState()
  const { hasBuiltInSearch } = useSearchProviderAvailability()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { dataCollection } = useSettings({ data_collection: true })
  const { state, actions, stepIndex, totalSteps } = useOnboardingState({ isStandalone, hasBuiltInSearch })
  const accountPasskey = useAccountPasskey()
  const shouldOfferPasskeyStep = accountPasskey.isSettled && !accountPasskey.isUnavailable && !accountPasskey.passkey

  useEffect(() => {
    if (isOpen && state.currentStep === 8) {
      return preloadInBackground([loadOnboardingModelStep])
    }
    if (isOpen && state.currentStep === 9) {
      return preloadInBackground([loadOnboardingSearchStep])
    }
  }, [isOpen, state.currentStep])

  // Skip the step when it isn't offered (no passkey support, or the account
  // already has one), but only once that's known: the skip is persisted, so
  // skipping while still loading would lose the step for good.
  const skipPasskeyStep = useEffectEvent(() => {
    runAction(actions.skipStep)
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

  const [isNavigating, startNavigation] = useTransition()
  const [completionError, setCompletionError] = useState<string | null>(null)
  const donationMutation = useMutation({ mutationFn: (enabled: boolean) => dataCollection.setValue(enabled) })
  const isCelebration = state.currentStep === onboardingStepCount
  const isBusy = isNavigating || state.isSubmittingName || state.isSubmittingLocation || serverState.isBusy
  const continueDisabled =
    isBusy ||
    (!isCelebration && !state.canGoNext) ||
    (state.currentStep === passkeyStep && !accountPasskey.isSettled) ||
    (isCelebration && (dataCollection.isLoading || donationMutation.isPending || donationMutation.isError))

  const runAction = (action: () => Promise<void>) => {
    startNavigation(async () => {
      setCompletionError(null)
      try {
        await action()
      } catch (error) {
        console.error('Failed to update onboarding:', error)
        if (isCelebration) {
          setCompletionError(t`Could not finish setup. Please try again.`)
        }
      }
    })
  }

  const handleContinue = () => {
    if (continueDisabled) {
      return
    }
    if (state.currentStep === 8) {
      serverState.continueSetup(() => runAction(actions.nextStep))
      return
    }
    runAction(isCelebration ? actions.completeOnboarding : actions.nextStep)
  }

  const handleBackAction = () => {
    if (isBusy || (state.currentStep === 8 && serverState.goBack())) {
      return
    }
    if (state.canGoBack) {
      runAction(actions.prevStep)
    }
  }

  const handleSkipAction = () => {
    if (!isBusy && state.canSkip) {
      runAction(actions.skipStep)
    }
  }

  return (
    <>
      <DialogTitle className="sr-only">
        <Trans>Onboarding Wizard</Trans>
      </DialogTitle>
      <DialogDescription className="sr-only">
        <Trans>Complete the setup process to get started with {appName}</Trans>
      </DialogDescription>
      <div
        className={cn('flex h-full flex-col items-center', !isMobile && 'pb-6 pt-8')}
        style={isMobile ? { paddingBottom: 'var(--kb, 0px)' } : undefined}
      >
        <div className="relative flex w-full shrink-0 items-center justify-center px-4 pb-2">
          <StepIndicators currentStep={stepIndex + 1} totalSteps={totalSteps} />
        </div>
        {state.currentStep === 9 || state.currentStep === 10 ? (
          <Suspense fallback={<Loader2 className="size-6 animate-spin self-center text-muted-foreground" />}>
            {state.currentStep === 9 ? (
              <OnboardingModelStep onBack={handleBackAction} onContinue={actions.nextStep} onSkip={actions.skipStep} />
            ) : (
              <OnboardingSearchStep onBack={handleBackAction} onContinue={actions.nextStep} onSkip={actions.skipStep} />
            )}
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

            {state.currentStep === 2 && (
              <OnboardingAuthStep
                isProcessing={state.processingOAuth}
                isConnected={state.isProviderConnected}
                onConnectionChange={actions.setProviderConnected}
                onDisconnect={handleProviderDisconnect}
              />
            )}
            {state.currentStep === 3 && (
              <OnboardingNameStep state={{ ...state, isSubmittingName: isBusy }} actions={actions} />
            )}
            {state.currentStep === 4 && (
              <OnboardingLocationStep state={{ ...state, isSubmittingLocation: isBusy }} actions={actions} />
            )}
            {state.currentStep === 5 && <OnboardingLanguageStep />}
            {state.currentStep === passkeyStep && !accountPasskey.isSettled && (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {state.currentStep === passkeyStep && shouldOfferPasskeyStep && <OnboardingPasskeyStep />}
            {state.currentStep === onboardingStepCount && (
              <OnboardingCelebrationStep
                donateUsageData={dataCollection.value}
                onDonationChange={donationMutation.mutate}
                donationDisabled={dataCollection.isLoading || donationMutation.isPending || isNavigating}
              />
            )}
            {isCelebration && donationMutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                <Trans>Could not save your preference. Please try again.</Trans>
              </p>
            )}
            {completionError && (
              <p role="alert" className="text-sm text-destructive">
                {completionError}
              </p>
            )}
          </div>
        )}
        {state.currentStep !== 9 && state.currentStep !== 10 && (
          <div className="relative flex w-full shrink-0 px-5 pt-2">
            <OnboardingActionButtons
              onBack={isCelebration ? undefined : state.canGoBack ? handleBackAction : undefined}
              onSkip={isCelebration ? undefined : state.canSkip ? handleSkipAction : undefined}
              onContinue={handleContinue}
              showBack={isCelebration ? false : state.canGoBack}
              backDisabled={isBusy}
              showSkip={isCelebration || state.currentStep === 8 ? false : state.canSkip}
              showContinue={state.currentStep !== 8 || serverState.isChoosingSetup}
              skipDisabled={
                isBusy ||
                (state.currentStep === 2 && state.isProviderConnected) ||
                (state.currentStep === 3 && state.isNameValid) ||
                (state.currentStep === 4 && state.isLocationValid)
              }
              continueDisabled={continueDisabled}
              continueText={
                state.currentStep === 8 && serverState.isConnecting ? (
                  <Trans>Connecting…</Trans>
                ) : isCelebration && isNavigating ? (
                  <Trans>Completing…</Trans>
                ) : (
                  <Trans>Continue</Trans>
                )
              }
            />
          </div>
        )}
      </div>
    </>
  )
}
