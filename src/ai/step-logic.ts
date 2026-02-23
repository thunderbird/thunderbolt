import { mistralNudges, mistralSearchNudges } from '@/ai/prompts/vendors/mistral/nudges'
import { gptOssNudges, gptOssSearchNudges } from '@/ai/prompts/vendors/openai/nudges'

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

/** Get the appropriate nudge messages for a vendor/mode combination */
export const getNudgeMessages = (modeName?: string, vendor?: string): NudgeMessages => {
  if (vendor === 'openai') return modeName === 'search' ? gptOssSearchNudges : gptOssNudges
  if (vendor === 'mistral') return modeName === 'search' ? mistralSearchNudges : mistralNudges
  return modeName === 'search' ? searchModeNudges : nudgeMessages
}
