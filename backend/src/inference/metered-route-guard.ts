/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { Elysia, type AnyElysia } from 'elysia'
import { rejectUnregisteredCliDevice } from './cli-device'
import type { InferenceDatabase } from './usage-ledger'

export type MeteredRouteGuardOptions = {
  auth: Auth
  database: InferenceDatabase
  cliDeviceRegistrationEnabled: boolean
  /** The inference-tier user rate limit; omitted in tests that do not exercise it. */
  rateLimit?: AnyElysia
}

/**
 * Guards every route registered after it on the parent that spends managed inference: a session (the auth
 * macro), a CLI device-grant session bound to its device, then the user rate limit. The order matters: the
 * device check and the rate limit both read the `user` the macro resolves.
 */
export const createMeteredRouteGuard = ({
  auth,
  database,
  cliDeviceRegistrationEnabled,
  rateLimit,
}: MeteredRouteGuardOptions) =>
  new Elysia()
    .use(createAuthMacro(auth))
    .guard({ auth: true })
    .onBeforeHandle(({ request, session, user }) =>
      rejectUnregisteredCliDevice(database, cliDeviceRegistrationEnabled, { request, session, user }),
    )
    .use(rateLimit ?? new Elysia())
    .as('scoped')
