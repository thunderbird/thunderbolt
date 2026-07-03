/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { computeOnboardingSteps, isProviderStep, isStepSkippable } from './onboarding-steps'

describe('computeOnboardingSteps', () => {
  it('server mode skips the provider steps', () => {
    expect(computeOnboardingSteps('server')).toEqual(['privacy', 'integrations', 'name', 'location', 'celebration'])
  })

  it('standalone mode prepends model + search provider steps', () => {
    expect(computeOnboardingSteps('standalone')).toEqual([
      'model-provider',
      'search-provider',
      'privacy',
      'integrations',
      'name',
      'location',
      'celebration',
    ])
  })

  it('standalone auto-skips the search step when a provider already supplies search', () => {
    const steps = computeOnboardingSteps('standalone', { hasSearchProvider: true })
    expect(steps).not.toContain('search-provider')
    expect(steps[0]).toBe('model-provider')
    expect(steps).toContain('privacy')
  })

  it('every mode ends on celebration', () => {
    expect(computeOnboardingSteps('server').at(-1)).toBe('celebration')
    expect(computeOnboardingSteps('standalone').at(-1)).toBe('celebration')
  })
})

describe('isStepSkippable', () => {
  it('privacy and celebration are not skippable', () => {
    expect(isStepSkippable('privacy')).toBe(false)
    expect(isStepSkippable('celebration')).toBe(false)
  })
  it('provider, integrations, name, location are skippable', () => {
    for (const step of ['model-provider', 'search-provider', 'integrations', 'name', 'location'] as const) {
      expect(isStepSkippable(step)).toBe(true)
    }
  })
})

describe('isProviderStep', () => {
  it('flags only the two provider steps', () => {
    expect(isProviderStep('model-provider')).toBe(true)
    expect(isProviderStep('search-provider')).toBe(true)
    expect(isProviderStep('privacy')).toBe(false)
  })
})
