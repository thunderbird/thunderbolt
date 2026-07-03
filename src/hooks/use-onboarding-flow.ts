/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react'
import { useProviders } from '@/dal'
import { getActiveTrustDomain } from '@/stores/trust-domain-registry'
import { useSettings } from '@/hooks/use-settings'
import {
  computeOnboardingSteps,
  isProviderStep,
  isStepSkippable,
  type OnboardingMode,
  type OnboardingStepKey,
} from '@/lib/onboarding-steps'

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max)

const resolveMode = (): OnboardingMode => (getActiveTrustDomain()?.kind === 'standalone' ? 'standalone' : 'server')

export type UseOnboardingFlowResult = {
  mode: OnboardingMode
  steps: OnboardingStepKey[]
  currentStep: OnboardingStepKey
  /** 1-based position for the step indicator. */
  stepNumber: number
  totalSteps: number
  isFirstStep: boolean
  isLastStep: boolean
  canSkip: boolean
  isLoading: boolean
  goNext: () => Promise<void>
  goBack: () => Promise<void>
  /** Advance past a skippable step; raises the provider nag for provider steps. */
  skip: () => Promise<void>
  /** Mark onboarding complete and reset the persisted step. */
  complete: () => Promise<void>
}

/**
 * Drives the full-screen onboarding step-router (spec-standalone §11). The
 * sequence is derived from the trust domain (standalone vs server) and the set
 * of connected providers (search step auto-skips when a provider already
 * supplies search). The current position is persisted in `onboarding_current_step`
 * (1-based), which is the single reactive source of truth — no effect needed.
 */
export const useOnboardingFlow = (): UseOnboardingFlowResult => {
  const mode = resolveMode()
  const providers = useProviders()
  const hasSearchProvider = useMemo(
    () => providers.some((p) => (p.enabledCapabilities ?? []).includes('search')),
    [providers],
  )
  const steps = useMemo(() => computeOnboardingSteps(mode, { hasSearchProvider }), [mode, hasSearchProvider])

  const { onboardingCurrentStep, userHasCompletedOnboarding, providerSetupSkipped } = useSettings({
    onboarding_current_step: '1',
    user_has_completed_onboarding: false,
    provider_setup_skipped: 'false',
  })

  const rawStep = parseInt(onboardingCurrentStep.value || '1', 10)
  const index = clamp((Number.isFinite(rawStep) ? rawStep : 1) - 1, 0, steps.length - 1)
  const currentStep = steps[index]

  const setStep = (oneBased: number) => onboardingCurrentStep.setValue(String(clamp(oneBased, 1, steps.length)))

  const goNext = async () => {
    await setStep(index + 2)
  }
  const goBack = async () => {
    await setStep(index)
  }
  const skip = async () => {
    if (isProviderStep(currentStep)) {
      await providerSetupSkipped.setValue('true')
    }
    await setStep(index + 2)
  }
  const complete = async () => {
    await Promise.all([userHasCompletedOnboarding.setValue(true), onboardingCurrentStep.setValue('1')])
  }

  return {
    mode,
    steps,
    currentStep,
    stepNumber: index + 1,
    totalSteps: steps.length,
    isFirstStep: index === 0,
    isLastStep: index === steps.length - 1,
    canSkip: isStepSkippable(currentStep),
    isLoading: onboardingCurrentStep.isLoading,
    goNext,
    goBack,
    skip,
    complete,
  }
}
