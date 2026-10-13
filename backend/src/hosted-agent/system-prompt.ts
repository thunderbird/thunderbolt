/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { currentDateTimeLine } from '@shared/i18n/current-date-time'
import { languageInstruction } from '@shared/i18n/language-instruction'
import { matchExactLocale, sourceLocale } from '@shared/i18n/locales'

type AgentSystemPromptInput = {
  /** `AGENT_SYSTEM_PROMPT`, empty when unset. */
  operatorPrompt: string
  /** Raw `X-App-Language` header value, or null when absent. */
  appLanguage: string | null
  /** `AGENT_TIMEZONE`, the zone the date line is written in. */
  timeZone: string
  now: Date
}

/**
 * Build the hosted agent's system prompt for one request: the operator's `AGENT_SYSTEM_PROMPT` first, then
 * a language rule whose fallback names the app language from the request's `X-App-Language` header, then
 * the current date and time.
 *
 * The header is client-controlled, so {@link matchExactLocale} validates it and only a shipped tag's English
 * name reaches the prompt; an absent or unknown tag falls back to English. The prompt body stays English,
 * like the built-in pipeline's.
 */
export const buildAgentSystemPrompt = ({ operatorPrompt, appLanguage, timeZone, now }: AgentSystemPromptInput) => {
  const language = languageInstruction(matchExactLocale(appLanguage) ?? sourceLocale, { toolResults: false })
  // The date line changes every minute, so it goes last: everything before it is identical across requests in
  // the same language and stays a cacheable prefix for the provider's prompt caching.
  return [operatorPrompt, language, currentDateTimeLine(now, timeZone)].filter(Boolean).join('\n\n')
}
