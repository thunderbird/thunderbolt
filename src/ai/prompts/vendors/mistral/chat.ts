import type { PromptOverride } from '../../types'

/**
 * Mistral chat mode override — enforces citation discipline.
 *
 * Mistral consistently produces detailed chat responses but omits [N] citations
 * even when it has used tools and has source data. This override places the
 * citation requirement prominently in the mode instructions.
 */
export const mistralChatOverride: PromptOverride = {
  modeAddendum: `MANDATORY: Every fact in your response that came from a tool result MUST have a [N] citation at the end of the sentence. Do not skip citations — a response without [N] markers is considered incomplete. If you used tools, your response MUST contain at least one [N].`,
}
