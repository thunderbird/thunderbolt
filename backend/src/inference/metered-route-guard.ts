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
   * Set on a confidential route to add the personal-access-token check before the CLI check: a PAT is
   * refused unless this is true. Left unset, PATs pass, as on the direct managed routes.
   */
  confidentialApiKeysEnabled?: boolean
  /** The inference-tier user rate limit; omitted in tests that do not exercise it. */
  rateLimit?: AnyElysia
}

/**
 * Guards the direct managed-inference routes (`/v1/chat` and the hosted agent) registered after it on the
 * parent: a session (the auth macro), optionally the confidential PAT check, a CLI device-grant session bound
 * to its device, then the user rate limit. The order matters: every later step reads the `user` the macro
 * resolves. Tinfoil and the receipt route still wire these by hand.
 */
export const createMeteredRouteGuard = ({
  auth,
  database,
  cliDeviceRegistrationEnabled,
  confidentialApiKeysEnabled,
  rateLimit,
}: MeteredRouteGuardOptions) =>
  new Elysia()
    .use(createAuthMacro(auth))
    .guard({ auth: true })
    // Destructure, never take the whole context: Elysia would infer the hook reads `body` and parse it early.
    .onBeforeHandle(({ request }) =>
      confidentialApiKeysEnabled === undefined
        ? undefined
        : rejectPersonalAccessToken({ request }, confidentialApiKeysEnabled),
    )
    .onBeforeHandle(({ request, session, user }) =>
      rejectUnregisteredCliDevice(database, cliDeviceRegistrationEnabled, { request, session, user }),
    )
    .use(rateLimit ?? new Elysia())
    .as('scoped')
