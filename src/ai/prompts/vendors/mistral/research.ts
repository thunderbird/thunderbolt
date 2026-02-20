import type { PromptOverride } from '../../types'

/**
 * Mistral research mode override — enforces citation discipline.
 *
 * Mistral writes thorough research reports but consistently omits [N] citations.
 * This override places citation requirements at both the tools level and as a
 * mode addendum to maximize visibility.
 */
export const mistralResearchOverride: PromptOverride = {
  modeAddendum: `CITATION CHECK (mandatory before finishing):
1. Count the [N] citations in your response
2. If fewer than 5, go back through your text and add [N] after every fact that came from a tool result
3. Every paragraph MUST have at least one [N] citation
4. Use a different number for each distinct source — [1], [2], [3], etc.
Do NOT submit a response with zero citations — this is a hard requirement.`,
}
