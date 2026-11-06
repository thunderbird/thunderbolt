/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia } from 'elysia'

/**
 * A user rate limit that refuses every request with 429 and `Retry-After`, mounted like
 * `createUserTierRateLimit`'s. `seenUserIds` records the `ctx.user` each call saw (undefined when the auth
 * resolve has not run yet), so a test can pin that the limiter runs after the session is resolved.
 */
export const createRejectingRateLimit = () => {
  const seenUserIds: Array<string | undefined> = []
  const rateLimit = new Elysia()
    .onBeforeHandle((ctx) => {
      seenUserIds.push((ctx as { user?: { id: string } }).user?.id)
      ctx.set.status = 429
      ctx.set.headers['Retry-After'] = '60'
      return { error: 'Too many requests' }
    })
    .as('scoped')
  return { rateLimit, seenUserIds }
}
