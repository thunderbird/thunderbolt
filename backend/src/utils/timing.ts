/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Round a monotonic duration to hundredths of a millisecond. */
export const elapsedMs = (startedAt: number, completedAt: number): number =>
  Math.round((completedAt - startedAt) * 100) / 100
