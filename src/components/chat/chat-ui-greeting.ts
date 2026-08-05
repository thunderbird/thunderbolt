/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Returns a time-of-day greeting for `hour` (0–23; defaults to the current local hour). */
export const getGreeting = (hour: number = new Date().getHours()): string => {
  if (hour < 5) {
    return 'Up late?'
  }
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return `Good ${timeOfDay}`
}
