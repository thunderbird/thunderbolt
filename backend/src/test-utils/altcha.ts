/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { solveChallenge } from 'altcha-lib/v1'
import type { Challenge } from 'altcha-lib/v1/types'

/** Solve an ALTCHA challenge and encode the result as the widget sends it in `x-captcha-token`. */
export const solveAltchaChallenge = async (challenge: Challenge, overrides: Record<string, unknown> = {}) => {
  const solution = await solveChallenge(challenge.challenge, challenge.salt, challenge.algorithm, challenge.maxnumber)
    .promise
  if (!solution) {
    throw new Error('ALTCHA challenge has no solution within maxnumber')
  }
  return btoa(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number: solution.number,
      salt: challenge.salt,
      signature: challenge.signature,
      took: solution.took,
      ...overrides,
    }),
  )
}
