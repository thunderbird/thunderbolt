/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { APIError } from 'better-auth'
import { Elysia, type AnyElysia } from 'elysia'
import { type Auth, createAuth } from './auth'

/** Resolve a session while translating credential rejection into an unauthenticated result. */
const resolveAuthSession = async (auth: Auth, headers: Headers) => {
  try {
    return await auth.api.getSession({ headers })
  } catch (error) {
    if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403)) {
      return null
    }

    throw error
  }
}

/**
 * Reusable auth macro plugin. Use with `{ auth: true }` on routes
 * to require authentication and get typed `user`/`session` on context.
 */
export const createAuthMacro = (auth: Auth) =>
  new Elysia({ name: 'auth-macro' }).macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await resolveAuthSession(auth, headers)

        if (!session?.user) {
          return status(401)
        }

        return {
          user: session.user,
          session: session.session,
        }
      },
    },
  })

const sessionCookiePrefix = 'better-auth.session_token='

/**
 * Passkey ceremonies run with `credentials: 'include'` (the WebAuthn challenge
 * needs its cookie), which also sends any Better Auth session cookie the browser
 * still holds. This app authenticates passkey routes by bearer token, so that
 * session cookie is only ever stale — and Better Auth resolves the FIRST cookie
 * of a duplicated name while the bearer plugin appends its token cookie LAST, so
 * the stale one wins and a valid bearer request 401s (THU-790). No Better Auth
 * `before` hook can undo this (the bearer plugin rebuilds the cookie from the
 * original request headers), so strip the stale session cookie here, before the
 * handler sees the request. Scoped to passkey routes carrying a bearer token, so
 * cookie-authenticated flows (SSO) are untouched.
 */
export const stripStaleSessionCookie = (request: Request): Request => {
  const authorization = request.headers.get('authorization')
  const cookie = request.headers.get('cookie')
  if (!cookie?.includes(sessionCookiePrefix) || !authorization?.toLowerCase().startsWith('bearer ')) {
    return request
  }
  const filtered = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(sessionCookiePrefix))
    .join('; ')
  const headers = new Headers(request.headers)
  if (filtered) {
    headers.set('cookie', filtered)
  } else {
    headers.delete('cookie')
  }
  return new Request(request, { headers })
}

/** Create a Better Auth plugin for Elysia with the provided database. */
export const createBetterAuthPlugin = (database: typeof DbType, ipRateLimit?: AnyElysia) => {
  const auth = createAuth(database)

  const plugin = new Elysia({ name: 'better-auth' })
  if (ipRateLimit) {
    plugin.use(ipRateLimit)
  }
  // Use .all() instead of .mount() — Elysia's mount() short-circuits the
  // request pipeline before onBeforeHandle, silently bypassing rate limiting.
  plugin.all(
    '/*',
    ({ request }) =>
      auth.handler(new URL(request.url).pathname.includes('/passkey/') ? stripStaleSessionCookie(request) : request),
    { parse: 'none' },
  )

  return { plugin, auth }
}

export type { Auth }
