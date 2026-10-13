/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sourceLocale } from './locales'

type CurrentDateTimeOptions = {
  /** IANA zone or UTC offset to format in; the host's local zone when omitted. */
  timeZone?: string
  /** `hour` drops the minutes, so the line changes once an hour instead of every minute. */
  granularity?: 'minute' | 'hour'
}

/**
 * The `Current date/time: …` line a system prompt carries so the model knows today's date.
 *
 * Model-facing context, not display, so it formats in the source locale whatever the app language: an
 * English date is unambiguous for the model to read back.
 *
 * Both callers put it after everything else in the system prompt, so the text before it stays identical
 * across requests. That does not keep it out of a prefix cache: `system` is sent ahead of the conversation, so
 * whenever this line changes, a provider that caches the conversation can no longer reuse it.
 *
 * - The hosted agent (`backend/src/hosted-agent/system-prompt.ts`) passes `granularity: 'hour'` and
 *   `AGENT_TIMEZONE`. On a Fireworks model, whose prompt cache reuses the conversation per user, its prefix
 *   then changes once an hour and later turns within the hour reuse the system prompt plus history.
 *   Anthropic models are sent without cache control, so nothing is cached for them either way.
 * - The built-in prompt (`src/ai/prompt.ts`) keeps the default minutes and the device's own zone, so its
 *   output, and the eval baselines recorded through the real pipeline, do not move.
 *
 * @param date The moment to describe.
 */
export const currentDateTimeLine = (
  date: Date,
  { timeZone, granularity = 'minute' }: CurrentDateTimeOptions = {},
): string =>
  `Current date/time: ${date.toLocaleString(sourceLocale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: granularity === 'minute' ? '2-digit' : undefined,
    timeZoneName: 'short',
    timeZone,
  })}`
