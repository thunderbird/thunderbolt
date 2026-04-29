/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ModelProfile } from '@/types'

type Step = { finishReason: string }

type Message = {
  role: string
  content?: string | Array<{ type: string; text?: string }>
}

/**
 * Check if the current step is the final step in the agentic loop.
 * On the final step, we disable tools to force the model to respond.
 */
export const isFinalStep = (currentStepCount: number, maxSteps: number): boolean => currentStepCount >= maxSteps - 1

/**
 * Check if we should show a preventive nudge to encourage the model to respond.
 * This triggers after the model has made many tool calls (6+ total) without responding.
 */
export const shouldShowPreventiveNudge = (steps: Step[], threshold = 6): boolean =>
  steps.filter((s) => s.finishReason === 'tool-calls').length >= threshold

/**
 * Extract all text content from assistant messages.
 * Used to detect empty responses that need retry.
 */
export const extractTextFromMessages = (messages: Message[]): string =>
  messages.reduce((acc, msg) => {
    if (msg.role === 'assistant' && 'content' in msg) {
      const textContent = Array.isArray(msg.content)
        ? msg.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('')
        : typeof msg.content === 'string'
          ? msg.content
          : ''
      return acc + textContent
    }
    return acc
  }, '')

/**
 * Check if any assistant message contains tool calls.
 */
export const hasToolCalls = (messages: Message[]): boolean =>
  messages.some(
    (msg) =>
      msg.role === 'assistant' &&
      'content' in msg &&
      Array.isArray(msg.content) &&
      msg.content.some((c) => c.type === 'tool-call'),
  )

/**
 * Determine if we should retry after an empty response.
 * We only retry if:
 * - The response text is empty (after trimming whitespace)
 * - The model made tool calls (so there's information to synthesize)
 * - We haven't exhausted our retry attempts
 */
export const shouldRetry = (
  totalText: string,
  hadToolCalls: boolean,
  attemptNumber: number,
  maxAttempts: number,
): boolean => totalText.trim().length === 0 && hadToolCalls && attemptNumber < maxAttempts

/** Keys for agentic loop nudge messages */
type NudgeKey = 'finalStep' | 'preventive' | 'retry'

/** Shape for a complete set of nudge messages — adding a new key requires all sets to update */
export type NudgeMessages = Readonly<Record<NudgeKey, string>>

/** Nudge messages used during the agentic loop */
export const nudgeMessages: NudgeMessages = {
  finalStep: 'RESPOND NOW with the information gathered. Do not ask questions.',
  preventive: 'Synthesize your tool results and respond now.',
  retry: 'Respond now with the information gathered. No more tools.',
}

/** Mode-specific nudge overrides */
export const searchModeNudges: NudgeMessages = {
  finalStep:
    'RESPOND NOW with link preview widgets. Use this exact format: <widget:link-preview url="https://full-url-here" /> — each must have a url attribute with the full URL. No duplicate URLs. No homepages.',
  preventive:
    'You have enough results. Respond now with <widget:link-preview url="https://..." /> widgets. Each MUST include the url attribute with the full page URL.',
  retry:
    'Respond now. Output <widget:link-preview url="https://full-url-here" /> for each result. The url attribute is REQUIRED — without it, nothing will render. No more tools.',
}

/** Compute the prepareStep overrides for a single step of the agentic loop */
export const buildStepOverrides = <TMessage>({
  steps,
  messages,
  systemPrompt,
  profile,
  maxSteps,
  nudgeThreshold,
  activeNudges,
}: {
  steps: Step[]
  messages: TMessage[]
  systemPrompt: string
  profile: ModelProfile | null
  maxSteps: number
  nudgeThreshold: number
  activeNudges: NudgeMessages
}) => {
  const hadToolCallSteps = steps.some((s) => s.finishReason === 'tool-calls')
  const citationSystem =
    profile?.citationReinforcementEnabled === 1 && hadToolCallSteps
      ? systemPrompt + (profile.citationReinforcementPrompt ?? '')
      : undefined

  if (isFinalStep(steps.length, maxSteps)) {
    return {
      system: citationSystem,
      activeTools: [] as never[],
      messages: [...messages, { role: 'user' as const, content: activeNudges.finalStep }],
    }
  }

  if (shouldShowPreventiveNudge(steps, nudgeThreshold)) {
    return {
      system: citationSystem,
      messages: [...messages, { role: 'user' as const, content: activeNudges.preventive }],
    }
  }

  if (citationSystem) {
    return { system: citationSystem }
  }
}

/** Default inference config applied when no profile override exists */
export const inferenceDefaults = {
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
} as const

/** Get the appropriate nudge messages from a model profile, falling back to code defaults */
export const getNudgeMessagesFromProfile = (profile: ModelProfile | null, modeName?: string): NudgeMessages => {
  const isSearch = modeName === 'search'

  if (!profile) {
    return isSearch ? searchModeNudges : nudgeMessages
  }

  if (isSearch) {
    const hasSearchOverrides = profile.nudgeSearchFinalStep || profile.nudgeSearchPreventive || profile.nudgeSearchRetry
    if (hasSearchOverrides) {
      return {
        finalStep: profile.nudgeSearchFinalStep ?? searchModeNudges.finalStep,
        preventive: profile.nudgeSearchPreventive ?? searchModeNudges.preventive,
        retry: profile.nudgeSearchRetry ?? searchModeNudges.retry,
      }
    }
    return searchModeNudges
  }

  const hasNudgeOverrides = profile.nudgeFinalStep || profile.nudgePreventive || profile.nudgeRetry
  if (hasNudgeOverrides) {
    return {
      finalStep: profile.nudgeFinalStep ?? nudgeMessages.finalStep,
      preventive: profile.nudgePreventive ?? nudgeMessages.preventive,
      retry: profile.nudgeRetry ?? nudgeMessages.retry,
    }
  }
  return nudgeMessages
}
