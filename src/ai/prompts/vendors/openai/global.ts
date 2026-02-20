import type { PromptOverride } from '../../types'

/**
 * GPT-OSS global override — applies to all modes.
 *
 * Addresses two issues:
 * 1. Blank responses: GPT-OSS sometimes makes tool calls and finishes with empty text
 * 2. Non-English queries: GPT-OSS may skip tools when the user writes in another language
 *
 * NOTE: Citation format ([N] vs link-preview) is NOT specified here because it differs
 * by mode. Chat/Research use [N], Search uses <widget:link-preview>. Mode-specific
 * overrides handle citation format.
 */
export const openaiGlobalOverride: PromptOverride = {
  tools: `After calling tools, you MUST write a text response for the user. Never finish with only tool calls and no text. If tool results are unclear, summarize what you found anyway.
The user may write in any language. Regardless of the language, you MUST always use tools to find current information before responding.`,
}
