/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import type { BetterAuthOptions } from 'better-auth'
import { customSession } from 'better-auth/plugins'
import type { AuthAdapter } from './access'
import { getMemberAuthorization } from './roles'

/** The caller's roles in the current org, live on each read. Anonymous users are not members. */
export const getSessionRoles = async (
  { adapter, database }: { adapter: AuthAdapter; database: QueryableDatabase },
  user: { id: string; isAnonymous?: boolean | null },
): Promise<string[]> =>
  user.isAnonymous ? [] : [...(await getMemberAuthorization({ adapter, database }, user.id)).roles]

/**
 * Adds `user.roles` to the session the app reads over HTTP, so it can show admin UI. Only a cosmetic
 * signal: every admin route rechecks. Server-side `auth.api.getSession` calls (every authenticated
 * request) skip the lookup and carry no `roles`, so the type is optional.
 */
export const sessionRolesPlugin = <O extends BetterAuthOptions>(database: QueryableDatabase, options: O) =>
  customSession(async ({ user, session }, ctx) => {
    if (!ctx.request) {
      return { user: user as typeof user & { roles?: string[] }, session }
    }
    return {
      user: { ...user, roles: await getSessionRoles({ adapter: ctx.context.adapter, database }, user) },
      session,
    }
  }, options)
