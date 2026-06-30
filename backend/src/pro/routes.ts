/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia } from 'elysia'
import { exaPlugin } from './exa'

/**
 * Create pro tools routes
 */
export const createProToolsRoutes = (auth: Auth, rateLimit?: AnyElysia) => {
  const app = new Elysia({ prefix: '/pro' }).onError(safeErrorHandler)

  return app.use(createAuthMacro(auth)).guard({ auth: true }, (guardedApp) => {
    if (rateLimit) {
      guardedApp.use(rateLimit)
    }

    return guardedApp.use(exaPlugin)
  })
}
