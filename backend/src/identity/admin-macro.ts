/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, resolveAuthSession } from '@/auth/elysia-plugin'
import { getSettings, isRequestOriginAllowed } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'
import { recordFailedAttempt } from './audit/write'
import { adminRole, getMemberAuthorization } from './roles'

/**
 * Elysia macro for admin routes: `{ admin: true }` re-checks, on every request, that the caller
 * is signed in and holds the admin role in the current org. A browser on an origin we don't serve is
 * refused first: CORS doesn't stop a form another site posts with the admin's session cookie. A role
 * refusal writes an `admin.access_denied` audit event.
 */
export const createAdminMacro = (auth: Auth, database: typeof DbType) =>
  new Elysia({ name: 'admin-macro' }).macro({
    admin: {
      async resolve({ status, request }) {
        if (!isRequestOriginAllowed(request, getSettings())) {
          return status(403, { code: 'ORIGIN_NOT_ALLOWED' })
        }
        const session = await resolveAuthSession(auth, request.headers)
        if (!session?.user) {
          return status(401, { code: 'UNAUTHENTICATED' })
        }

        const { adapter } = await auth.$context
        const { roles } = await getMemberAuthorization({ adapter, database }, session.user.id)
        if (!roles.has(adminRole)) {
          await recordFailedAttempt(database, {
            action: 'admin.access_denied',
            outcome: 'denied',
            reason: 'ADMIN_REQUIRED',
            actor: { type: 'user', id: session.user.id },
            metadata: { method: request.method, path: new URL(request.url).pathname },
          })
          return status(403, { code: 'ADMIN_REQUIRED' })
        }

        return { user: session.user, session: session.session }
      },
    },
  })

/**
 * The base every admin route group builds on: each route registered on it requires admin, with
 * no per-route opt-in to forget.
 */
export const createAdminRoutes = (name: string, auth: Auth, database: typeof DbType) =>
  new Elysia({ name }).onError(safeErrorHandler).use(createAdminMacro(auth, database)).guard({ admin: true })
