/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ModelProfile } from '@/types'
import { defaultModelGptOss120b } from '@/defaults/models'

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
  userId: null,
}
