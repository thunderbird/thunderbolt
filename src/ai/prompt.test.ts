/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { ModelProfile } from '@/types'
import { createPrompt, type PromptParams } from './prompt'

const createStubProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  modelId: 'test-model',
  temperature: null,
  maxSteps: null,
  maxAttempts: null,
  nudgeThreshold: null,
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

const baseParams: PromptParams = {
  modelName: 'Test Model',
  profile: null,
  modeName: null,
  preferredName: 'Alice',
  location: { name: 'New York', lat: 40.7, lng: -74.0 },
  localization: {
    distanceUnit: 'imperial',
    temperatureUnit: 'f',
    dateFormat: 'MM/DD/YYYY',
    timeFormat: '12h',
    currency: 'USD',
  },
  integrationStatus: 'READY',
}

describe('createPrompt', () => {
  test('includes model name', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('**Test Model**')
  })

  test('includes user name when set', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('User name: Alice')
  })

  test('omits user name when empty', () => {
    const result = createPrompt({ ...baseParams, preferredName: '' })
    expect(result).not.toContain('User name:')
  })

  test('includes location when set', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('New York')
    expect(result).toContain('40.7')
  })

  test('shows unknown location fallback', () => {
    const result = createPrompt({ ...baseParams, location: {} })
    expect(result).toContain('User location: Unknown')
  })

  test('does not include overrides when profile is null', () => {
    const result = createPrompt(baseParams)
    expect(result).not.toContain('tools_override_text')
  })

  test('includes toolsOverride from profile', () => {
    const profile = createStubProfile({ toolsOverride: 'CUSTOM_TOOLS_OVERRIDE' })
    const result = createPrompt({ ...baseParams, profile })
    expect(result).toContain('CUSTOM_TOOLS_OVERRIDE')
  })

  test('includes linkPreviewsOverride from profile', () => {
    const profile = createStubProfile({ linkPreviewsOverride: 'CUSTOM_LINK_PREVIEWS' })
    const result = createPrompt({ ...baseParams, profile })
    expect(result).toContain('CUSTOM_LINK_PREVIEWS')
  })

  test('includes chatModeAddendum when modeName is chat', () => {
    const profile = createStubProfile({ chatModeAddendum: 'CHAT_ADDENDUM' })
    const result = createPrompt({ ...baseParams, profile, modeName: 'chat', modeSystemPrompt: 'Chat mode active' })
    expect(result).toContain('CHAT_ADDENDUM')
  })

  test('includes searchModeAddendum when modeName is search', () => {
    const profile = createStubProfile({ searchModeAddendum: 'SEARCH_ADDENDUM' })
    const result = createPrompt({ ...baseParams, profile, modeName: 'search', modeSystemPrompt: 'Search mode' })
    expect(result).toContain('SEARCH_ADDENDUM')
  })

  test('includes researchModeAddendum when modeName is research', () => {
    const profile = createStubProfile({ researchModeAddendum: 'RESEARCH_ADDENDUM' })
    const result = createPrompt({ ...baseParams, profile, modeName: 'research', modeSystemPrompt: 'Research mode' })
    expect(result).toContain('RESEARCH_ADDENDUM')
  })

  test('does not include mode addendum when mode system prompt is absent', () => {
    const profile = createStubProfile({ chatModeAddendum: 'SHOULD_NOT_APPEAR' })
    const result = createPrompt({ ...baseParams, profile, modeName: 'chat' })
    expect(result).not.toContain('SHOULD_NOT_APPEAR')
  })

  test('includes Active Mode section when modeSystemPrompt is set', () => {
    const result = createPrompt({ ...baseParams, modeSystemPrompt: 'Mode instructions here' })
    expect(result).toContain('# Active Mode')
    expect(result).toContain('Mode instructions here')
  })

  test('omits Active Mode section when modeSystemPrompt is absent', () => {
    const result = createPrompt(baseParams)
    expect(result).not.toContain('# Active Mode')
  })
})
