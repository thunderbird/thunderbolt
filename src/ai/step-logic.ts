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
  finalStep:
    'RESPOND NOW. Provide your answer using the information you have gathered. Do not ask questions—give your best response immediately.',
  preventive:
    'You have gathered information from multiple tool calls. Please synthesize the results and provide your response to the user now.',
  retry:
    'You called tools but did not provide a response. Please synthesize all the information you gathered and respond to me now. Do not call any more tools.',
  toolRefusal:
    'You have access to all the tools listed in the system prompt. Do not claim you cannot access files, integrations, or services—use the appropriate tool instead. If a user asks about Google Drive, OneDrive, email, or calendar, you have tools for those.',
} as const

/** Generic refusal patterns that apply regardless of which integrations are enabled */
const genericRefusalPatterns = [
  'not connected to',
  'not currently connected',
  "i'm not connected",
  'i am not connected',
  'share the file with me',
  'make the file public',
  'publicly accessible',
  // File access refusals
  'cannot access its content',
  "can't access its content",
  'cannot access the content',
  "can't access the content",
  'is private, so i cannot',
  'is private so i cannot',
]

/** Integration-specific refusal patterns - only checked if that integration is enabled */
const integrationRefusalPatterns = {
  google: [
    "don't have access to your google",
    'do not have access to your google',
    "can't access your google",
    'cannot access your google',
    "can't access your drive",
    'cannot access your drive',
    "can't access your gmail",
    'cannot access your gmail',
    "can't access your calendar",
    'cannot access your calendar',
    // Google Sheets/Docs specific
    'google sheet is private',
    'google doc is private',
    'sheet is private',
    'doc is private',
    'spreadsheet is private',
    'document is private',
    'cannot access the sheet',
    "can't access the sheet",
    'cannot access the spreadsheet',
    "can't access the spreadsheet",
    'share the sheet',
  ],
  microsoft: [
    "don't have access to your onedrive",
    'do not have access to your onedrive',
    "can't access your onedrive",
    'cannot access your onedrive',
    "can't access your outlook",
    'cannot access your outlook',
    // OneDrive/SharePoint specific
    'file is private, so i cannot',
    'cannot access the file directly',
    "can't access the file directly",
  ],
} as const

export type EnabledIntegrations = {
  google?: boolean
  microsoft?: boolean
}

/**
 * Check if the model's response contains patterns indicating it's refusing to use available tools.
 * Only checks for refusals of integrations that are actually enabled.
 * This prevents false positives when the model legitimately says it can't access a disabled integration.
 */
export const detectsToolRefusal = (text: string, enabledIntegrations: EnabledIntegrations = {}): boolean => {
  const lowerText = text.toLowerCase()
  const includes = (pattern: string) => lowerText.includes(pattern)

  return (
    genericRefusalPatterns.some(includes) ||
    (enabledIntegrations.google === true && integrationRefusalPatterns.google.some(includes)) ||
    (enabledIntegrations.microsoft === true && integrationRefusalPatterns.microsoft.some(includes))
  )
}
