/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { ModelProfile } from '@/types'
import { widgetRegistry } from '@/widgets'
import { appHarnessEnvironmentPrompt } from '@shared/agent-core/environment-prompt'
import { assembleBuiltInModelInput, createPrompt, createPromptParts, type PromptParams } from './prompt'

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
  hasWebTools: false,
}

describe('assembleBuiltInModelInput', () => {
  const sharedHistory = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ]

  test('keeps the stable prefix byte-identical and ends on the current user turn', () => {
    const firstPrompt = createPromptParts(baseParams, new Date('2026-07-10T12:00:00Z'))
    const secondPrompt = createPromptParts(baseParams, new Date('2026-07-10T12:01:00Z'))
    const fixedVolatileNotes = ['Voice mode is active.', 'Follow project style.', 'Ask responses: concise']
    const firstUserMessage = { role: 'user' as const, content: 'first follow-up' }
    const secondUserMessage = { role: 'user' as const, content: 'second follow-up' }
    const first = assembleBuiltInModelInput(
      firstPrompt.stablePrompt,
      [...sharedHistory, firstUserMessage],
      [firstPrompt.volatilePrompt, ...fixedVolatileNotes],
    )
    const second = assembleBuiltInModelInput(
      secondPrompt.stablePrompt,
      [...sharedHistory, secondUserMessage],
      [secondPrompt.volatilePrompt, ...fixedVolatileNotes],
    )
    const firstMessages = [{ role: 'system' as const, content: first.system }, ...first.messages]
    const secondMessages = [{ role: 'system' as const, content: second.system }, ...second.messages]
    const stablePrefixLength = sharedHistory.length + 1

    expect(firstMessages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'system', 'user'])
    expect(firstMessages.slice(0, stablePrefixLength)).toEqual(secondMessages.slice(0, stablePrefixLength))
    expect(firstMessages.slice(stablePrefixLength)).not.toEqual(secondMessages.slice(stablePrefixLength))
    expect(first.system).not.toContain('Current date/time')
    expect(first.messages.at(-2)?.content).toContain('Current date/time')
    expect(first.messages.at(-1)).toEqual(firstUserMessage)
  })

  test('places volatile notes before a sole message and trails with them when input is empty', () => {
    const userMessage = { role: 'user' as const, content: 'hello' }
    const volatileMessage = { role: 'system' as const, content: 'Current date/time: now' }

    expect(assembleBuiltInModelInput('stable', [userMessage], [volatileMessage.content]).messages).toEqual([
      volatileMessage,
      userMessage,
    ])
    expect(assembleBuiltInModelInput('stable', [], [volatileMessage.content]).messages).toEqual([volatileMessage])
  })
})

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

  test('includes chatModeAddendum from profile', () => {
    const profile = createStubProfile({ chatModeAddendum: 'CHAT_ADDENDUM' })
    const result = createPrompt({ ...baseParams, profile })
    expect(result).toContain('CHAT_ADDENDUM')
  })

  test('always includes the Conversation Style section with the chat instructions', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('# Conversation Style')
    expect(result).toContain('Make quick decisions')
  })

  test('includes web tool rules in the stable prompt when the web tools are available', () => {
    const result = createPromptParts({ ...baseParams, hasWebTools: true })

    expect(result.stablePrompt).toContain('Web lookups use the `search` and `fetch_content` tools')
  })

  test('omits web tool rules from the stable prompt when the web tools are unavailable', () => {
    const result = createPromptParts({ ...baseParams, hasWebTools: false })

    expect(result.stablePrompt).not.toContain('Web lookups use the `search` and `fetch_content` tools')
  })

  test('includes the reuse-before-search gate', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('reuse first, then search')
    expect(result).toContain("Don't repeat a tool call you already made")
  })

  test('keeps the time-sensitive re-search carve-out', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('time-sensitive that may have changed')
  })

  test('keeps the verify-before-answering directive', () => {
    const result = createPrompt(baseParams)
    expect(result).toContain('never state facts without verifying them first')
  })

  test('tool-capable models get the skill listing without instruction bodies', () => {
    const result = createPrompt({
      ...baseParams,
      supportsTools: true,
      skills: [
        {
          name: 'daily-brief',
          description: 'Use for a daily rundown.',
          instruction: 'Gather private full instructions here.',
        },
      ],
    })

    expect(result).toContain('## Skills')
    expect(result).toContain('Use the `skill` tool')
    expect(result).toContain('- daily-brief: Use for a daily rundown.')
    expect(result).not.toContain('Gather private full instructions here.')
  })

  test('non-tool models get the skill catalog and full instruction bodies inline', () => {
    const result = createPrompt({
      ...baseParams,
      supportsTools: false,
      skills: [
        {
          name: 'weather',
          description: 'Use for weather forecasts.',
          instruction: 'Emit the weather widget contract.',
        },
      ],
    })

    expect(result).toContain('- weather: Use for weather forecasts.')
    expect(result).toContain('Full skill instructions:')
    expect(result).toContain('### weather\nEmit the weather widget contract.')
    expect(result).not.toContain('Use the `skill` tool')
  })

  test('does not inject widget instruction bodies into every prompt', () => {
    const result = createPrompt(baseParams)

    for (const widget of widgetRegistry) {
      if ('instructions' in widget.module) {
        expect(result).not.toContain(widget.module.instructions)
      }
    }
    expect(result).not.toContain('# Widget Components')
  })

  test('keeps citation tags forbidden after removing widget instruction injection', () => {
    const result = createPrompt(baseParams)

    expect(result).toContain('Do not emit <widget:citation> tags')
  })

  test('keeps the per-turn timestamp at the end of the complete stateless prompt', () => {
    const result = createPrompt(baseParams)
    expect(result.indexOf('Current date/time')).toBeGreaterThan(result.indexOf('# Output Format'))
    expect(result.indexOf('Current date/time')).toBeGreaterThan(result.indexOf('# Tools'))
  })

  test('keeps the stable # Context block (user profile + integration status) in the prefix', () => {
    const result = createPrompt(baseParams)
    expect(result.indexOf('# Context')).toBeLessThan(result.indexOf('# Tools'))
    expect(result.indexOf('Integration status:')).toBeLessThan(result.indexOf('# Tools'))
  })

  test('keeps user-controlled fields out of the trailing suffix (no injection-by-recency)', () => {
    const result = createPrompt(baseParams)
    expect(result.indexOf('User name:')).toBeLessThan(result.indexOf('Current date/time'))
    expect(result.indexOf('User location:')).toBeLessThan(result.indexOf('Current date/time'))
  })

  test('appends the timestamp after the Conversation Style block so it stays last', () => {
    const result = createPrompt(baseParams)
    expect(result.indexOf('# Conversation Style')).toBeLessThan(result.indexOf('Current date/time'))
  })

  test('separates stable instructions from the minute-precision timestamp', () => {
    const first = createPromptParts(baseParams, new Date('2026-07-10T12:00:01Z'))
    const sameMinute = createPromptParts(baseParams, new Date('2026-07-10T12:00:59Z'))
    const nextMinute = createPromptParts(baseParams, new Date('2026-07-10T12:01:00Z'))

    expect(first.stablePrompt).toBe(nextMinute.stablePrompt)
    expect(first.stablePrompt).not.toContain('Current date/time')
    expect(first.volatilePrompt).toBe(sameMinute.volatilePrompt)
    expect(first.volatilePrompt).not.toBe(nextMinute.volatilePrompt)
    expect(first.fullPrompt).toBe(`${first.stablePrompt}\n\n${first.volatilePrompt}`)
  })

  test('does not include the Pi app harness environment', () => {
    const result = createPromptParts(baseParams)

    expect(result.fullPrompt).not.toContain(appHarnessEnvironmentPrompt)
  })
})
