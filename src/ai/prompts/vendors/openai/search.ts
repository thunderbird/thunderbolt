import type { PromptOverride } from '../../types'

/**
 * GPT-OSS search mode — without this override, GPT-OSS outputs citation badges
 * ([1] [2]) instead of rich <widget:link-preview url="..."> cards.
 */
export const openaiSearchOverride: PromptOverride = {
  modeAddendum: `CRITICAL: Your response MUST use <widget:link-preview url="https://..." /> tags with a url attribute containing the FULL URL.
Example of CORRECT output:
<widget:link-preview url="https://reuters.com/technology/ai-disruption-fears-2026-02-14" />
<widget:link-preview url="https://apnews.com/article/pentagon-ai-classified-networks" />

Do NOT output just citation numbers like [1] [2] — those render as tiny badges, not rich preview cards.
Do NOT omit the url attribute — <widget:link-preview source="1" /> without url will NOT render a preview card.
Every link preview MUST have a url="https://..." attribute with the full page URL you fetched.`,
}
