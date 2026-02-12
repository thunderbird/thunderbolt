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

/** Nudge messages used during the agentic loop */
export const nudgeMessages = {
  finalStep: 'RESPOND NOW with the information gathered. Cite with [N] at end of sentence. Do not ask questions.',
  preventive: 'Synthesize your tool results and respond now. Cite with [N] at end of sentence.',
  retry:
    'Respond now with the information gathered. Every sourced fact must have [N] at end of sentence. No more tools.',
  afterTools:
    'Every fact from tool results MUST have [N] at end of sentence. Example: "The population is 14 million.[1] The area spans 2,194 km².[2]"',
} as const

/** Mode-specific nudge overrides */
export const searchModeNudges = {
  finalStep:
    'RESPOND NOW with link preview widgets for each result. Use <widget:link-preview> tags. Do not ask questions.',
  preventive: 'You have enough results. Respond now with <widget:link-preview> widgets for each result.',
  retry: 'Respond now with <widget:link-preview> widgets. No more tools.',
  afterTools: 'Remember: respond with <widget:link-preview source="N" url="..."> tags for each result.',
} as const

/** Get the appropriate nudge messages for a mode */
export const getNudgeMessages = (modeName?: string) => (modeName === 'search' ? searchModeNudges : nudgeMessages)
