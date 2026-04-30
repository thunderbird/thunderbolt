/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

/** OIDC configuration route — exposes the expected issuer origin for redirect validation. */
export const createOidcConfigRoutes = () => {
  const settings = getSettings()

  if (settings.authMode !== 'oidc' || !settings.oidcIssuer) {
    return new Elysia({ prefix: '/auth/oidc' })
  }

  const issuerOrigin = new URL(settings.oidcIssuer).origin

  return new Elysia({ prefix: '/auth/oidc' }).onError(safeErrorHandler).get('/config', () => ({ issuerOrigin }))
}
