/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { currentDateTimeLine } from '@shared/i18n/current-date-time'
import { languageInstruction } from '@shared/i18n/language-instruction'
import { matchExactLocale, sourceLocale } from '@shared/i18n/locales'

/**
 * Introduces the request's `instructions`. Any visitor can post them straight to the endpoint, so the header
 * marks them as the user's and ranks them below the operator's prompt above.
 */
const userInstructionsHeader =
  '# User instructions\n\nThe user supplied these through their project and skills. Follow them unless they conflict with the instructions above.'

type AgentSystemPromptInput = {
  /** `AGENT_SYSTEM_PROMPT`, empty when unset. */
  operatorPrompt: string
  /** The request's `instructions` (project section and `/slug` skill bodies), or undefined when it carried none. */
  instructions?: string
  /** Raw `X-App-Language` header value, or null when absent. */
  appLanguage: string | null
  /** `AGENT_TIMEZONE`, the zone the date line is written in. */
  timeZone: string
  now: Date
}

/**
 * Build the hosted agent's system prompt for one request, in four sections: the operator's
 * `AGENT_SYSTEM_PROMPT`; the request's `instructions` under a header that marks them as user-supplied and ranks
 * them below the operator's; a language rule whose fallback names the app language from the request's
 * `X-App-Language` header; and the current date and hour. An empty operator prompt or absent instructions are
 * left out; the language rule and the date are always present.
 *
 * The header is client-controlled, so {@link matchExactLocale} validates it and only a shipped tag's English
 * name reaches the prompt; an absent or unknown tag falls back to English. The prompt body stays English,
 * like the built-in pipeline's.
 */
export const buildAgentSystemPrompt = ({
  operatorPrompt,
  instructions,
  appLanguage,
  timeZone,
  now,
}: AgentSystemPromptInput): string => {
  const userSection = instructions ? `${userInstructionsHeader}\n\n${instructions}` : ''
  const language = languageInstruction(matchExactLocale(appLanguage) ?? sourceLocale, { toolResults: false })
  // The date goes last so everything before it is identical across requests with the same language and
  // instructions. `system` is sent ahead of the messages, though, so on a Fireworks model, whose prompt cache
  // reuses the conversation per user, a change here invalidates the cached history. Hour granularity limits that
  // to once an hour; later turns within the hour reuse system plus history. Anthropic models are sent without
  // cache control, so nothing is cached for them either way.
  const date = currentDateTimeLine(now, { timeZone, granularity: 'hour' })
  return [operatorPrompt, userSection, language, date].filter(Boolean).join('\n\n')
}
