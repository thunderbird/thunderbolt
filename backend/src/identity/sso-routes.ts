/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { QueryableDatabase } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import { type AnyElysia, Elysia, t } from 'elysia'
import { discoverSsoConnections, isSsoAuthMode } from './sso-connections'

type SsoRoutesOptions = {
  settings: Settings
  database: QueryableDatabase
  ipRateLimit?: AnyElysia
}

/**
 * `POST /sso/discover`: the SSO connections the login screen offers for an email. Public, so it
 * answers from the email's domain only and never says whether the address is a member. The email
 * travels in the body to keep it out of access logs. Mounted only in SSO mode.
 */
export const createSsoRoutes = ({ settings, database, ipRateLimit }: SsoRoutesOptions) => {
  const app = new Elysia({ prefix: '/sso' }).onError(safeErrorHandler)
  if (!isSsoAuthMode(settings)) {
    return app
  }
  if (ipRateLimit) {
    app.use(ipRateLimit)
  }
  return app.post(
    '/discover',
    async ({ body }) => ({ connections: await discoverSsoConnections(database, body.email) }),
    { body: t.Object({ email: t.Optional(t.String({ maxLength: 320 })) }) },
  )
}
