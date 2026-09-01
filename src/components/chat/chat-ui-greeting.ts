/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

const upLate = msg`Up late?`
const goodMorning = msg`Good morning`
const goodAfternoon = msg`Good afternoon`
const goodEvening = msg`Good evening`

/**
 * Returns a time-of-day greeting for `hour` (0–23; defaults to the current
 * local hour), as a descriptor the caller resolves with `i18n._()`.
 *
 * Whole greetings rather than `Good ${timeOfDay}`: the time-of-day word is not
 * a substitutable noun across languages, and a fragment is invisible to the
 * extractor.
 */
export const getGreeting = (hour: number = new Date().getHours()): MessageDescriptor => {
  if (hour < 5) {
    return upLate
  }
  if (hour < 12) {
    return goodMorning
  }
  if (hour < 18) {
    return goodAfternoon
  }
  return goodEvening
}
