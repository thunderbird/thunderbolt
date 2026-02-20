import type { NudgeMessages } from '@/ai/step-logic'

/**
 * Mistral-specific nudge messages — every nudge explicitly mentions [N] citations.
 *
 * Mistral's core issue isn't blank responses (like GPT-OSS) — it's writing detailed
 * responses WITHOUT citing sources. By embedding citation reminders into every nudge,
 * the model gets a citation prompt at the exact moment it's about to write.
 */
export const mistralNudges: NudgeMessages = {
  finalStep:
    'Respond now with the information gathered. Every fact from a tool result must have [N] at the end of its sentence, where N matches the source number.',
  preventive: 'Synthesize your tool results and respond now. Remember: cite every fact with [N] at end of sentence.',
  retry: 'Respond now with the information gathered. Add [N] citations after every sourced fact. No more tools.',
}

export const mistralSearchNudges: NudgeMessages = {
  finalStep:
    'Respond now with link preview widgets. Use <widget:link-preview url="https://full-url-here" /> for each result. No duplicate URLs. No homepages.',
  preventive: 'You have enough results. Respond with <widget:link-preview url="https://..." /> widgets now.',
  retry:
    'Respond now with <widget:link-preview url="https://full-url-here" /> for each result. The url attribute is required.',
}
