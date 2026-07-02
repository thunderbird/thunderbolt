/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { ModelProfile } from '@/types'
import { defaultModelProfiles, hashModelProfile } from './model-profiles'

const createStubProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  modelId: 'test-model',
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  toolsOverride: null,
  linkPreviewsOverride: null,
  chatModeAddendum: null,
  searchModeAddendum: null,
  researchModeAddendum: null,
  citationReinforcementEnabled: 0,
  citationReinforcementPrompt: null,
  nudgeFinalStep: null,
  nudgePreventive: null,
  nudgeRetry: null,
  nudgeSearchFinalStep: null,
  nudgeSearchPreventive: null,
  nudgeSearchRetry: null,
  providerOptions: null,
  defaultHash: null,
  deletedAt: null,
  userId: null,
  ...overrides,
})

describe('hashModelProfile', () => {
  test('produces deterministic hashes', () => {
    const profile = createStubProfile()
    expect(hashModelProfile(profile)).toBe(hashModelProfile(profile))
  })

  test('changes when temperature changes', () => {
    const a = createStubProfile({ temperature: 0.2 })
    const b = createStubProfile({ temperature: 0.3 })
    expect(hashModelProfile(a)).not.toBe(hashModelProfile(b))
  })

  test('changes when deletedAt changes', () => {
    const a = createStubProfile({ deletedAt: null })
    const b = createStubProfile({ deletedAt: '2024-01-01T00:00:00.000Z' })
    expect(hashModelProfile(a)).not.toBe(hashModelProfile(b))
  })

  test('does not change when modelId changes', () => {
    const a = createStubProfile({ modelId: 'model-a' })
    const b = createStubProfile({ modelId: 'model-b' })
    expect(hashModelProfile(a)).toBe(hashModelProfile(b))
  })

  test('does not change when defaultHash changes', () => {
    const a = createStubProfile({ defaultHash: 'hash-a' })
    const b = createStubProfile({ defaultHash: 'hash-b' })
    expect(hashModelProfile(a)).toBe(hashModelProfile(b))
  })

  test('changes when toolsOverride changes', () => {
    const a = createStubProfile({ toolsOverride: null })
    const b = createStubProfile({ toolsOverride: 'custom override' })
    expect(hashModelProfile(a)).not.toBe(hashModelProfile(b))
  })

  test('changes when providerOptions changes', () => {
    const a = createStubProfile({ providerOptions: null })
    const b = createStubProfile({ providerOptions: { systemMessageMode: 'developer' } })
    expect(hashModelProfile(a)).not.toBe(hashModelProfile(b))
  })
})

describe('defaultModelProfiles', () => {
  test('contains three profiles', () => {
    expect(defaultModelProfiles).toHaveLength(3)
  })

  test('each profile has a non-null modelId', () => {
    for (const profile of defaultModelProfiles) {
      expect(profile.modelId).toBeTruthy()
    }
  })
})
