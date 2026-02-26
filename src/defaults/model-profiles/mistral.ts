import type { ModelProfile } from '@/types'
import { defaultModelMistralMedium31 } from '@/defaults/models'

export const defaultModelProfileMistralMedium31: ModelProfile = {
  modelId: defaultModelMistralMedium31.id,
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: null,
  toolsOverride: `CITATION RULE: After EVERY tool call, you MUST add [N] citations to your response. This is mandatory, not optional. Each [N] corresponds to the source number from the tool result. If you used 3 different sources, your response must contain at least [1], [2], and [3].
Do NOT stop after just 1-2 tool calls. For requests involving link previews, you need at minimum: 1 search + 1 aggregate fetch + 3 individual page fetches = 5 tool calls.`,
  linkPreviewsOverride: `SIMPLIFIED LINK PREVIEW WORKFLOW (follow these exact steps):
1. Search for the topic (e.g. "top news today apnews")
2. Fetch the FIRST aggregate/homepage result to discover article URLs
3. From that page's content, identify 3-5 individual article/product URLs (they have paths like /article/abc123 or /2026/02/15/story-name)
4. Fetch EACH individual URL
5. Show <widget:link-preview> ONLY for the individually fetched URLs
NEVER show a URL whose path is "/" or a short section like "/ai/", "/news/", "/technology/" — these are NOT individual pages.
NEVER show the same URL twice.
NEVER link to review-site aggregates (pcmag.com/picks, cnet.com/best, wirecutter.com).`,
  chatModeAddendum: `MANDATORY: Every fact in your response that came from a tool result MUST have a [N] citation at the end of the sentence. Do not skip citations — a response without [N] markers is considered incomplete. If you used tools, your response MUST contain at least one [N].`,
  searchModeAddendum: `Before responding, verify EACH link you plan to show:
- Did you fetch the page and find substantive content (an article, product page, or detailed guide)?
- If the fetched content is just a navigation menu, list of links, or generic landing page, REMOVE that link and search for a better one.
- Never repeat the same URL.`,
  researchModeAddendum: `CITATION CHECK (mandatory before finishing):
1. Count the [N] citations in your response
2. If fewer than 5, go back through your text and add [N] after every fact that came from a tool result
3. Every paragraph MUST have at least one [N] citation
4. Use a different number for each distinct source — [1], [2], [3], etc.
Do NOT submit a response with zero citations — this is a hard requirement.`,
  citationReinforcementEnabled: 1,
  citationReinforcementPrompt: `\n\n<citation-format>\nWhen writing your response, place [N] after each fact from a tool result.\nN = the source number shown in the tool result as [Source N].\nEvery paragraph must contain at least one [N] reference.\n</citation-format>`,
  nudgeFinalStep: `Respond now with the information gathered. Every fact from a tool result must have [N] at the end of its sentence, where N matches the source number.`,
  nudgePreventive: `Synthesize your tool results and respond now. Remember: cite every fact with [N] at end of sentence.`,
  nudgeRetry: `Respond now with the information gathered. Add [N] citations after every sourced fact. No more tools.`,
  nudgeSearchFinalStep: `Respond now with link preview widgets. Use <widget:link-preview url="https://full-url-here" /> for each result. No duplicate URLs. No homepages.`,
  nudgeSearchPreventive: `You have enough results. Respond with <widget:link-preview url="https://..." /> widgets now.`,
  nudgeSearchRetry: `Respond now with <widget:link-preview url="https://full-url-here" /> for each result. The url attribute is required.`,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}
