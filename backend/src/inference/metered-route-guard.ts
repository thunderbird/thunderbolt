/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { Elysia, type AnyElysia } from 'elysia'
import { rejectUnregisteredCliDevice } from './cli-device'
import type { InferenceDatabase } from './usage-ledger'
import { rejectPersonalAccessToken } from './web-session'

export type MeteredRouteGuardOptions = {
  auth: Auth
  database: InferenceDatabase
  cliDeviceRegistrationEnabled: boolean
  /**
   * Whether an `x-api-key` personal access token may use the route. When false, a PAT is refused with 403
   * `WEB_LOGIN_REQUIRED` before the CLI check. Required so that a new route has to choose its PAT policy.
   */
  allowPersonalAccessTokens: boolean
  /** The route's user-keyed rate limit; omitted in tests that do not exercise it. */
  rateLimit?: AnyElysia
}

/**
 * Guards the managed-inference routes registered after it on the parent: those that call a model on the
 * deployment's provider account, metered or not, and the route that records usage against a user's budget.
 * In order: a session (the auth macro), the personal-access-token policy, a CLI device-grant session bound to
 * its device, then the user rate limit. The order matters: every later step reads the `user` the macro resolves.
 */
export const createMeteredRouteGuard = ({
  auth,
  database,
  cliDeviceRegistrationEnabled,
  allowPersonalAccessTokens,
  rateLimit,
}: MeteredRouteGuardOptions) => {
  const guard = new Elysia()
    .use(createAuthMacro(auth))
    .guard({ auth: true })
    // Destructure, never take the whole context: Elysia would infer the hook reads `body` and parse it early.
    .onBeforeHandle(({ request }) => rejectPersonalAccessToken({ request }, allowPersonalAccessTokens))
    .onBeforeHandle(({ request, session, user }) =>
      rejectUnregisteredCliDevice(database, cliDeviceRegistrationEnabled, { request, session, user }),
    )
  // A statement, not a chained `.use()`: `rateLimit` is `AnyElysia`, and chaining it would type every guarded
  // handler's context as `any`.
  if (rateLimit) {
    guard.use(rateLimit)
  }
  return guard.as('scoped')
}
