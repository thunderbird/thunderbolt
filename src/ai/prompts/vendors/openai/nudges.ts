import type { NudgeMessages } from '@/ai/step-logic'

/**
 * GPT-OSS-specific nudge messages.
 *
 * Key findings from E2E eval testing:
 * - Aggressive "RESPOND NOW" in all-caps causes the acknowledgment trap (empty responses)
 * - But too-soft language gets ignored on the final step, also causing blanks
 * - The sweet spot: direct language that tells the model WHAT to write, not just that it should respond
 * - Preventive nudge fires once at step 8 (nudgeThreshold in config) as a gentle heads-up
 */
export const gptOssNudges: NudgeMessages = {
  finalStep:
    'This is your last step — tools are no longer available. You must write your final answer now. Summarize the key facts from your tool results and present them clearly to the user. Do not leave the response empty.',
  preventive:
    'You have gathered substantial information. Start composing your response — you can still make a few more tool calls if needed, but begin writing your answer.',
  retry:
    'Your previous attempt produced no visible text. This is a retry — write your answer now using the information already gathered from tools. The user is waiting for a response.',
}

export const gptOssSearchNudges: NudgeMessages = {
  finalStep:
    'This is your last step — tools are no longer available. Output your results now using <widget:link-preview url="https://full-url-here" /> tags. Each must have a url attribute with the full URL. Do not leave the response empty.',
  preventive:
    'You have enough search results. Start writing your <widget:link-preview url="https://..." /> widgets — you can still make a few more tool calls if needed.',
  retry:
    'Your previous attempt produced no visible text. Output <widget:link-preview url="https://full-url-here" /> for each result you found. The url attribute is required.',
}
