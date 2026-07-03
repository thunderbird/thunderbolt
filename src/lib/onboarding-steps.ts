/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Onboarding step sequencing (spec-standalone §11). The flow is a full-screen
 * step-router whose sequence depends on the trust domain:
 *
 * - **standalone**: model provider → search provider → privacy → integrations →
 *   name → location → celebration.
 * - **server**: privacy → integrations → name → location → celebration (the
 *   provider steps are skipped; the server supplies models/search, and account
 *   login already happened before onboarding).
 *
 * The search-provider step auto-skips when a connected provider already supplies
 * `search` (e.g. Tinfoil offers models + search).
 */

export type OnboardingMode = 'standalone' | 'server'

export type OnboardingStepKey =
  | 'model-provider'
  | 'search-provider'
  | 'privacy'
  | 'integrations'
  | 'name'
  | 'location'
  | 'celebration'

/** Steps shared by both modes, in order. */
const sharedSteps: OnboardingStepKey[] = ['privacy', 'integrations', 'name', 'location', 'celebration']

/** Steps that a user may skip (provider steps warn + nag; name/location are optional). */
const skippableSteps: ReadonlySet<OnboardingStepKey> = new Set([
  'model-provider',
  'search-provider',
  'integrations',
  'name',
  'location',
])

export type ComputeStepsOptions = {
  /** A connected provider already supplies `search` — omit the search step. */
  hasSearchProvider?: boolean
}

/** Compute the ordered step list for a mode. Pure — unit-tested. */
export const computeOnboardingSteps = (
  mode: OnboardingMode,
  options: ComputeStepsOptions = {},
): OnboardingStepKey[] => {
  if (mode === 'server') {
    return [...sharedSteps]
  }
  const providerSteps: OnboardingStepKey[] = ['model-provider']
  if (!options.hasSearchProvider) {
    providerSteps.push('search-provider')
  }
  return [...providerSteps, ...sharedSteps]
}

/** Whether a step can be skipped (celebration/privacy are not skippable). */
export const isStepSkippable = (step: OnboardingStepKey): boolean => skippableSteps.has(step)

/** Provider onboarding steps whose skip should raise the persistent nag. */
export const isProviderStep = (step: OnboardingStepKey): boolean =>
  step === 'model-provider' || step === 'search-provider'
