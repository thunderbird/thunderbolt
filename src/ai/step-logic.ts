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
    'RESPOND NOW with link preview widgets. Each URL must be unique and point to a specific page (not a homepage). Use <widget:link-preview> tags.',
  preventive:
    'You have enough results. Before responding, verify: no duplicate URLs and no homepage URLs. Then respond with <widget:link-preview> widgets.',
  retry: 'Respond now with <widget:link-preview> widgets. Each must have a unique, specific-page URL. No more tools.',
}

/** Get the appropriate nudge messages for a mode */
export const getNudgeMessages = (modeName?: string): NudgeMessages =>
  modeName === 'search' ? searchModeNudges : nudgeMessages
