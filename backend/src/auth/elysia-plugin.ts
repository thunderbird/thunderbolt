/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { Elysia, type AnyElysia } from 'elysia'
import { type Auth, createAuth } from './auth'
import { createJwtMintRateLimit } from './jwt-rate-limit'

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
  const settings = getSettings()

  const plugin = new Elysia({ name: 'better-auth' })
  if (ipRateLimit) {
    plugin.use(ipRateLimit)
  }
  // Per-session rate limit + GET → 405 method gate on `/api/auth/token`.
  // Mounted before the route handlers so it short-circuits before any DB hit.
  plugin.use(createJwtMintRateLimit({ trustedProxy: settings.trustedProxy }))

  // Custom POST handler for the JWT mint endpoint.
  //
  // Better Auth's JWT plugin exposes `/token` as GET, which is unsuitable for
  // a token-issuing endpoint: GET responses are bookmarkable, prefetchable by
  // browser AI features, and embeddable as `<img src="…/api/auth/token">`
  // (CSRF-burn under any future SameSite=None config). We intercept POST here
  // and call `auth.api.getToken({ headers })` programmatically — Better Auth's
  // method binding only applies to its HTTP handler; the JS API is method-
  // agnostic and runs `sessionMiddleware` to enforce a valid session.
  //
  // GET on this path is blocked by the rate-limit middleware above (405).
  plugin.post('/api/auth/token', async ({ request }) => {
    try {
      const result = await auth.api.getToken({ headers: request.headers })
      return result
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 401
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })

  // Use .all() instead of .mount() — Elysia's mount() short-circuits the
  // request pipeline before onBeforeHandle, silently bypassing rate limiting.
  plugin.all('/*', ({ request }) => auth.handler(request), { parse: 'none' })

  return { plugin, auth }
}

export type { Auth }
