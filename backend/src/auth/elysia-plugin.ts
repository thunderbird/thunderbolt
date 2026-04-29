/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { Elysia, type AnyElysia } from 'elysia'
import { type Auth, createAuth } from './auth'

/**
 * Reusable auth macro plugin. Use with `{ auth: true }` on routes
 * to require authentication and get typed `user`/`session` on context.
 */
export const createAuthMacro = (auth: Auth) =>
  new Elysia({ name: 'auth-macro' }).macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers })

        if (!session) {
          return status(401)
        }

        return {
          user: session.user,
          session: session.session,
        }
      },
    },
  })

/** Create a Better Auth plugin for Elysia with the provided database. */
export const createBetterAuthPlugin = (database: typeof DbType, ipRateLimit?: AnyElysia) => {
  const auth = createAuth(database)

  const plugin = new Elysia({ name: 'better-auth' })
  if (ipRateLimit) {
    plugin.use(ipRateLimit)
  }
  // Use .all() instead of .mount() — Elysia's mount() short-circuits the
  // request pipeline before onBeforeHandle, silently bypassing rate limiting.
  plugin.all('/*', ({ request }) => auth.handler(request), { parse: 'none' })

  return { plugin, auth }
}

export type { Auth }
