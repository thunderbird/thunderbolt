/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { ModelProfile } from '@/types'
import { buildVolatileSystemNotes } from './fetch'
import { assembleBuiltInModelInput } from './prompt'
import {
  buildStepOverrides,
  extractTextFromMessages,
  getNudgeMessagesFromProfile,
  hasToolCalls,
  isFinalStep,
  nudgeMessages,
  shouldRetry,
  shouldShowPreventiveNudge,
} from './step-logic'

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

describe('isFinalStep', () => {
  test('returns true when on the last step', () => {
    expect(isFinalStep(19, 20)).toBe(true)
  })

  test('returns true when past the threshold', () => {
    expect(isFinalStep(20, 20)).toBe(true)
  })

  test('returns false when not yet at final step', () => {
    expect(isFinalStep(18, 20)).toBe(false)
  })

  test('returns false on first step', () => {
    expect(isFinalStep(0, 20)).toBe(false)
  })

  test('handles edge case of maxSteps = 1', () => {
    expect(isFinalStep(0, 1)).toBe(true)
  })
})

describe('shouldShowPreventiveNudge', () => {
  const createSteps = (toolCallCount: number, otherCount = 0) => [
    ...Array(toolCallCount).fill({ finishReason: 'tool-calls' }),
    ...Array(otherCount).fill({ finishReason: 'stop' }),
  ]

  test('returns true when tool calls reach threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(6))).toBe(true)
  })

  test('returns true when tool calls exceed threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(10))).toBe(true)
  })

  test('returns false when below threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(5))).toBe(false)
  })

  test('returns false with empty steps', () => {
    expect(shouldShowPreventiveNudge([])).toBe(false)
  })

  test('only counts tool-calls finish reason', () => {
    const mixedSteps = createSteps(3, 5) // 3 tool-calls, 5 stop
    expect(shouldShowPreventiveNudge(mixedSteps)).toBe(false)
  })

  test('respects custom threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(3), 3)).toBe(true)
    expect(shouldShowPreventiveNudge(createSteps(2), 3)).toBe(false)
  })
})

describe('extractTextFromMessages', () => {
  test('extracts text from string content', () => {
    const messages = [{ role: 'assistant', content: 'Hello world' }]
    expect(extractTextFromMessages(messages)).toBe('Hello world')
  })

  test('extracts text from array content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    ]
    expect(extractTextFromMessages(messages)).toBe('Hello world')
  })

  test('ignores non-text content types', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool-call', toolName: 'search' },
        ],
      },
    ]
    expect(extractTextFromMessages(messages)).toBe('Hello')
  })

  test('ignores user messages', () => {
    const messages = [
      { role: 'user', content: 'User text' },
      { role: 'assistant', content: 'Assistant text' },
    ]
    expect(extractTextFromMessages(messages)).toBe('Assistant text')
  })

  test('concatenates multiple assistant messages', () => {
    const messages = [
      { role: 'assistant', content: 'First ' },
      { role: 'user', content: 'ignored' },
      { role: 'assistant', content: 'Second' },
    ]
    expect(extractTextFromMessages(messages)).toBe('First Second')
  })

  test('returns empty string for empty messages', () => {
    expect(extractTextFromMessages([])).toBe('')
  })

  test('handles missing content property', () => {
    const messages = [{ role: 'assistant' }]
    expect(extractTextFromMessages(messages)).toBe('')
  })
})

describe('hasToolCalls', () => {
  test('returns true when tool-call exists', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: 'search' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(true)
  })

  test('returns false with only text content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for user messages with tool-call type', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool-call' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for string content', () => {
    const messages = [{ role: 'assistant', content: 'Hello' }]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for empty messages', () => {
    expect(hasToolCalls([])).toBe(false)
  })

  test('finds tool-call among mixed content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search' },
          { type: 'tool-call', toolName: 'search' },
        ],
      },
    ]
    expect(hasToolCalls(messages)).toBe(true)
  })
})

describe('shouldRetry', () => {
  test('returns true for empty text with tool calls and attempts remaining', () => {
    expect(shouldRetry('', true, 1, 2)).toBe(true)
  })

  test('returns true for whitespace-only text', () => {
    expect(shouldRetry('   \n\t  ', true, 1, 2)).toBe(true)
  })

  test('returns false when text is present', () => {
    expect(shouldRetry('Hello', true, 1, 2)).toBe(false)
  })

  test('returns false when no tool calls were made', () => {
    expect(shouldRetry('', false, 1, 2)).toBe(false)
  })

  test('returns false when max attempts reached', () => {
    expect(shouldRetry('', true, 2, 2)).toBe(false)
  })

  test('returns false when past max attempts', () => {
    expect(shouldRetry('', true, 3, 2)).toBe(false)
  })

  test('all conditions must be met', () => {
    // Missing any single condition should return false
    expect(shouldRetry('text', true, 1, 2)).toBe(false) // has text
    expect(shouldRetry('', false, 1, 2)).toBe(false) // no tool calls
    expect(shouldRetry('', true, 2, 2)).toBe(false) // no attempts left
  })
})

describe('nudgeMessages', () => {
  test('finalStep message is defined and non-empty', () => {
    expect(nudgeMessages.finalStep).toBeTruthy()
    expect(nudgeMessages.finalStep.length).toBeGreaterThan(0)
  })

  test('preventive message is defined and non-empty', () => {
    expect(nudgeMessages.preventive).toBeTruthy()
    expect(nudgeMessages.preventive.length).toBeGreaterThan(0)
  })

  test('retry message is defined and non-empty', () => {
    expect(nudgeMessages.retry).toBeTruthy()
    expect(nudgeMessages.retry.length).toBeGreaterThan(0)
  })

  test('web budget message is defined and non-empty', () => {
    expect(nudgeMessages.webBudget).toBeTruthy()
    expect(nudgeMessages.webBudget.length).toBeGreaterThan(0)
  })
})

describe('getNudgeMessagesFromProfile', () => {
  test('returns default nudges when no profile exists', () => {
    expect(getNudgeMessagesFromProfile(null)).toBe(nudgeMessages)
  })

  test('returns profile nudges when all override fields are set', () => {
    const profile = createStubProfile({
      nudgeFinalStep: 'custom final',
      nudgePreventive: 'custom preventive',
      nudgeRetry: 'custom retry',
    })
    const result = getNudgeMessagesFromProfile(profile)
    expect(result.finalStep).toBe('custom final')
    expect(result.preventive).toBe('custom preventive')
    expect(result.retry).toBe('custom retry')
    expect(result.webBudget).toBe(nudgeMessages.webBudget)
  })

  test('falls back to defaults for null nudge fields in partial override', () => {
    const profile = createStubProfile({ nudgeFinalStep: 'custom final' })
    const result = getNudgeMessagesFromProfile(profile)
    expect(result.finalStep).toBe('custom final')
    expect(result.preventive).toBe(nudgeMessages.preventive)
    expect(result.retry).toBe(nudgeMessages.retry)
    expect(result.webBudget).toBe(nudgeMessages.webBudget)
  })

  test('returns default nudges when profile has no nudge overrides', () => {
    const profile = createStubProfile()
    expect(getNudgeMessagesFromProfile(profile)).toBe(nudgeMessages)
  })
})

describe('buildStepOverrides', () => {
  const baseParams = {
    currentSystemPrompt: 'You are an assistant.',
    profile: null as ModelProfile | null,
    maxSteps: 20,
    nudgeThreshold: 6,
    activeNudges: nudgeMessages,
  }

  const toolCallSteps = (n: number) => Array(n).fill({ finishReason: 'tool-calls' })
  const textSteps = (n: number) => Array(n).fill({ finishReason: 'stop' })

  test('returns undefined when no conditions are met', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBeUndefined()
  })

  test('disables tools and nudges on final step', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(19),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result?.activeTools).toEqual([])
    expect(result?.messages?.[result.messages.length - 1]?.content).toBe(nudgeMessages.finalStep)
  })

  test('adds preventive nudge at threshold', () => {
    const result = buildStepOverrides({
      ...baseParams,
      nudgeThreshold: 6,
      steps: toolCallSteps(6),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result?.messages?.[result.messages.length - 1]?.content).toBe(nudgeMessages.preventive)
    expect(result?.activeTools).toBeUndefined()
  })

  test('does not nudge below threshold', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(5),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBeUndefined()
  })

  test('final step takes priority over preventive nudge', () => {
    const result = buildStepOverrides({
      ...baseParams,
      maxSteps: 7,
      nudgeThreshold: 6,
      steps: toolCallSteps(6),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result?.activeTools).toEqual([])
  })

  test('forces a response after a post-exhaustion web-tool attempt', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
      webBudgetProbe: { isExhausted: true, exhaustedAttempts: 1 },
    })

    expect(result?.toolChoice).toBe('none')
    expect(result?.messages?.[result.messages.length - 1]?.content).toBe(nudgeMessages.webBudget)
  })

  test('does not floor tools before a post-exhaustion attempt', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
      webBudgetProbe: { isExhausted: true, exhaustedAttempts: 0 },
    })

    expect(result).toBeUndefined()
  })

  test('final step takes priority over the web budget floor', () => {
    const result = buildStepOverrides({
      ...baseParams,
      steps: toolCallSteps(19),
      messages: [{ role: 'user', content: 'hello' }],
      webBudgetProbe: { isExhausted: true, exhaustedAttempts: 1 },
    })

    expect(result?.activeTools).toEqual([])
    expect(result?.messages?.[result.messages.length - 1]?.content).toBe(nudgeMessages.finalStep)
  })

  test('appends citation reinforcement when enabled and tool calls occurred', () => {
    const profile = createStubProfile({
      citationReinforcementEnabled: 1,
      citationReinforcementPrompt: '\n<cite>sources</cite>',
    })
    const result = buildStepOverrides({
      ...baseParams,
      currentSystemPrompt: 'You are an assistant.\n\nCurrent date/time: Friday, July 31, 2026',
      profile,
      steps: toolCallSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result?.system).toBe(
      'You are an assistant.\n\nCurrent date/time: Friday, July 31, 2026\n<cite>sources</cite>',
    )
    expect(result?.system).toContain('Current date/time')
  })

  test('preserves every volatile note in citation-reinforcement continuation steps', () => {
    const volatileSystemPrompt = 'Current date/time: Friday, July 31, 2026'
    const voiceNote = 'Voice mode is active.'
    const skillInstructions = '<skill-instructions>Follow project style.</skill-instructions>'
    const askResponsesNote = '<ask-responses>User chose concise.</ask-responses>'
    const volatileSystemNotes = buildVolatileSystemNotes({
      volatileSystemPrompt,
      voiceNotes: [voiceNote],
      skillSystemMessages: [skillInstructions],
      askResponsesNote,
    })
    const input = assembleBuiltInModelInput(
      'You are an assistant.',
      [{ role: 'user', content: 'hello' }],
      volatileSystemNotes,
    )
    const citationReinforcementPrompt = '\n<cite>sources</cite>'

    const result = buildStepOverrides({
      ...baseParams,
      currentSystemPrompt: input.system,
      profile: createStubProfile({
        citationReinforcementEnabled: 1,
        citationReinforcementPrompt,
      }),
      steps: toolCallSteps(1),
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result?.system).toBe(input.system + citationReinforcementPrompt)
    expect(result?.system).toContain(volatileSystemPrompt)
    expect(result?.system).toContain(voiceNote)
    expect(result?.system).toContain(skillInstructions)
    expect(result?.system).toContain(askResponsesNote)
    expect(result?.system).toContain('<cite>sources</cite>')
  })

  test('no citation reinforcement when disabled', () => {
    const result = buildStepOverrides({
      ...baseParams,
      profile: createStubProfile({ citationReinforcementEnabled: 0 }),
      steps: toolCallSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBeUndefined()
  })

  test('no citation reinforcement without tool calls', () => {
    const result = buildStepOverrides({
      ...baseParams,
      profile: createStubProfile({ citationReinforcementEnabled: 1, citationReinforcementPrompt: '\ncite' }),
      steps: textSteps(2),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBeUndefined()
  })

  test('includes citation system on final step when enabled', () => {
    const profile = createStubProfile({
      citationReinforcementEnabled: 1,
      citationReinforcementPrompt: '\ncite!',
    })
    const result = buildStepOverrides({
      ...baseParams,
      profile,
      steps: toolCallSteps(19),
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result?.system).toBe('You are an assistant.\ncite!')
    expect(result?.activeTools).toEqual([])
  })
})
