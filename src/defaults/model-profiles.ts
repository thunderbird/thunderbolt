import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import { defaultModelGptOss120b, defaultModelMistralMedium31, defaultModelSonnet45 } from '@/defaults/models'

/**
 * Compute hash of user-editable fields for a model profile
 * Includes deletedAt to treat soft-delete as a user configuration choice
 * Excludes modelId (PK) and defaultHash (the hash itself)
 */
export const hashModelProfile = (profile: ModelProfile): string => {
  return hashValues([
    profile.temperature,
    profile.maxSteps,
    profile.maxAttempts,
    profile.nudgeThreshold,
    profile.useSystemMessageModeDeveloper,
    profile.toolsOverride,
    profile.linkPreviewsOverride,
    profile.chatModeAddendum,
    profile.searchModeAddendum,
    profile.researchModeAddendum,
    profile.citationReinforcementEnabled,
    profile.citationReinforcementPrompt,
    profile.nudgeFinalStep,
    profile.nudgePreventive,
    profile.nudgeRetry,
    profile.nudgeSearchFinalStep,
    profile.nudgeSearchPreventive,
    profile.nudgeSearchRetry,
    profile.providerOptions ? JSON.stringify(profile.providerOptions) : null,
    profile.deletedAt,
  ])
}

/**
 * Default model profiles shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 *
 * Each profile is exported individually so it can be referenced by other modules
 */
export const defaultModelProfileGptOss120b: ModelProfile = {
  modelId: defaultModelGptOss120b.id,
  temperature: 0.3,
  maxSteps: 8,
  maxAttempts: 4,
  nudgeThreshold: 5,
  useSystemMessageModeDeveloper: 1,
  providerOptions: { systemMessageMode: 'developer' },
  toolsOverride: `After calling tools, you MUST write a text response for the user. Never finish with only tool calls and no text. If tool results are unclear, summarize what you found anyway.
The user may write in any language. Regardless of the language, you MUST always use tools to find current information before responding.`,
  linkPreviewsOverride: null,
  chatModeAddendum: `Important: Each distinct fact or claim must have its own [N] citation. For multi-part questions, use a different source for each part when possible. Aim for at least 2 citations in your response.`,
  searchModeAddendum: `CRITICAL: Your response MUST use <widget:link-preview url="https://..." /> tags with a url attribute containing the FULL URL.
Example of CORRECT output:
<widget:link-preview url="https://reuters.com/technology/ai-disruption-fears-2026-02-14" />
<widget:link-preview url="https://apnews.com/article/pentagon-ai-classified-networks" />

Do NOT output just citation numbers like [1] [2] — those render as tiny badges, not rich preview cards.
Do NOT omit the url attribute — <widget:link-preview source="1" /> without url will NOT render a preview card.
Every link preview MUST have a url="https://..." attribute with the full page URL you fetched.`,
  researchModeAddendum: `For research mode: every time you use information from a tool result, you MUST add [N] at the end of that sentence. Use a DIFFERENT [N] for each distinct source. Your final response needs at least 5 unique [N] citations — if you have fewer, go back and add citations to facts you missed.

CITATION CHECK: Before finishing your response, count your [N] citations. If you have fewer than 5 unique numbers, add more citations to facts that came from your tool results. Every paragraph should have at least one [N].`,
  citationReinforcementEnabled: 0,
  citationReinforcementPrompt: null,
  nudgeFinalStep: `This is your last step — tools are no longer available. You must write your final answer now. Summarize the key facts from your tool results and present them clearly to the user. Do not leave the response empty.`,
  nudgePreventive: `You have gathered substantial information. Start composing your response — you can still make a few more tool calls if needed, but begin writing your answer.`,
  nudgeRetry: `Your previous attempt produced no visible text. This is a retry — write your answer now using the information already gathered from tools. The user is waiting for a response.`,
  nudgeSearchFinalStep: `This is your last step — tools are no longer available. Output your results now using <widget:link-preview url="https://full-url-here" /> tags. Each must have a url attribute with the full URL. Do not leave the response empty.`,
  nudgeSearchPreventive: `You have enough search results. Start writing your <widget:link-preview url="https://..." /> widgets — you can still make a few more tool calls if needed.`,
  nudgeSearchRetry: `Your previous attempt produced no visible text. Output <widget:link-preview url="https://full-url-here" /> for each result you found. The url attribute is required.`,
  deletedAt: null,
  defaultHash: null,
}

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
}

export const defaultModelProfileSonnet45: ModelProfile = {
  modelId: defaultModelSonnet45.id,
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: null,
  toolsOverride: null,
  linkPreviewsOverride: null,
  chatModeAddendum: null,
  searchModeAddendum: null,
  researchModeAddendum: null,
  citationReinforcementEnabled: 0,
  citationReinforcementPrompt: null,
  nudgeFinalStep: null,
  nudgePreventive: null,
  nudgeRetry: null,
  nudgeSearchFinalStep: null,
  nudgeSearchPreventive: null,
  nudgeSearchRetry: null,
  deletedAt: null,
  defaultHash: null,
}

/**
 * Array of all default model profiles for iteration
 */
export const defaultModelProfiles: ReadonlyArray<ModelProfile> = [
  defaultModelProfileGptOss120b,
  defaultModelProfileMistralMedium31,
  defaultModelProfileSonnet45,
] as const
