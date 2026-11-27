/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'
import { getInvitationByToken } from './invitations'

/**
 * The accept screen's lookup. Unauthenticated: the token is the invitation link's 256-bit secret.
 * Anything not usable any more (unknown, expired, accepted, revoked) is the same 404.
 */
export const createInvitationRoutes = ({
  database,
  ipRateLimit,
}: {
  database: typeof DbType
  ipRateLimit?: AnyElysia
}) => {
  const app = new Elysia({ prefix: '/invitations' }).onError(safeErrorHandler)
  if (ipRateLimit) {
    app.use(ipRateLimit)
  }
  return app.get(
    '/:token',
    async ({ params, set }) => {
      const invitation = await getInvitationByToken(database, params.token)
      if (!invitation) {
        set.status = 404
        return { code: 'INVITATION_NOT_FOUND' }
      }
      return invitation
    },
    { params: t.Object({ token: t.String({ maxLength: 128 }) }) },
  )
}
