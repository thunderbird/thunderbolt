/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sourceLocale } from './locales'

/**
 * The `Current date/time: …` line a system prompt carries so the model knows today's date.
 *
 * Shared by the built-in prompt (`src/ai/prompt.ts`), which formats in the device's own zone, and the hosted
 * agent (`backend/src/hosted-agent/system-prompt.ts`), which passes `AGENT_TIMEZONE` because the server runs
 * in UTC. Model-facing context, not display, so it formats in the source locale whatever the app language:
 * an English date is unambiguous for the model to read back. The line changes every minute, so both callers
 * keep it after everything else in the prompt, where it cannot break the cacheable prefix.
 *
 * @param date The moment to describe.
 * @param timeZone IANA zone to format in; the host's local zone when omitted.
 */
export const currentDateTimeLine = (date: Date, timeZone?: string): string =>
  `Current date/time: ${date.toLocaleString(sourceLocale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  })}`
