import type { PromptOverride } from '../../types'

/**
 * GPT-OSS chat mode override — reinforces citation requirements.
 *
 * E2E eval testing showed GPT-OSS sometimes produces detailed responses but only
 * cites one source even for multi-part questions. This addendum reminds it to cite
 * each source separately.
 */
export const openaiChatOverride: PromptOverride = {
  modeAddendum: `Important: Each distinct fact or claim must have its own [N] citation. For multi-part questions, use a different source for each part when possible. Aim for at least 2 citations in your response.`,
}
