/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { resolveDiscoveryServerUrl } from '@/config/settings'
import { normalizeEmail } from '@/lib/email'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'

export type DiscoveryResponse = {
  serverUrl: string
}

type DiscoverySettings = Pick<Settings, 'discoveryServerMap' | 'discoveryDefaultServerUrl' | 'appUrl'>

type DiscoveryRoutesOptions = {
  ipRateLimit?: AnyElysia
}

/**
 * Email → server discovery for standalone onboarding (spec §10).
 *
 * Unauthenticated: it runs before the client has any server to authenticate
 * against. The response is UNIFORM regardless of whether the email matched a
 * configured server — unmatched emails resolve to the default public server — so
 * the endpoint never leaks which emails/domains map to which servers (mirrors the
 * waitlist privacy posture). The client then validates the returned URL via
 * `GET {serverUrl}/v1/config` before calling `activateServer()`.
 */
export const createDiscoveryRoutes = (settings: DiscoverySettings, options: DiscoveryRoutesOptions = {}) => {
  const app = new Elysia({ prefix: '/discovery' }).onError(safeErrorHandler)
  if (options.ipRateLimit) {
    app.use(options.ipRateLimit)
  }

  return app.post(
    '/',
    ({ body }): DiscoveryResponse => {
      const email = normalizeEmail(body.email)
      return { serverUrl: resolveDiscoveryServerUrl(email, settings) }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
}
