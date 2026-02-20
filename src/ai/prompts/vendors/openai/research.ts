import type { PromptOverride } from '../../types'

/**
 * GPT-OSS research mode override — enforces citation discipline.
 *
 * GPT-OSS writes thorough 5000-8000 char research reports but frequently
 * only cites 2-4 sources when 5+ are needed. The model does the research
 * (8-13 tool calls) but forgets to tag every fact with [N].
 */
export const openaiResearchOverride: PromptOverride = {
  tools: `For research mode: every time you use information from a tool result, you MUST add [N] at the end of that sentence. Use a DIFFERENT [N] for each distinct source. Your final response needs at least 5 unique [N] citations — if you have fewer, go back and add citations to facts you missed.`,
  modeAddendum: `CITATION CHECK: Before finishing your response, count your [N] citations. If you have fewer than 5 unique numbers, add more citations to facts that came from your tool results. Every paragraph should have at least one [N].`,
}
