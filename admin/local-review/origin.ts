/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

export const localReviewOrigin = 'http://127.0.0.1:1426'

/** Keep persisted demo configuration isolated from ordinary app development origins. */
export const assertLocalReviewOrigin = (origin: string, development: boolean): void => {
  if (!development || origin !== localReviewOrigin) {
    throw new Error(`Local admin review requires the dedicated development origin ${localReviewOrigin}`)
  }
}
