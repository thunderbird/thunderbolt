/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { APIError } from 'better-auth'
import { Elysia, type AnyElysia } from 'elysia'
import { type Auth, createAuth } from './auth'
import { passkeyVerifyPaths } from './paths'

/**
 * Resolve a session while translating credential rejection into an unauthenticated result.
 *
 * Exported because a route that calls `auth.api.getSession` directly does not
 * get this: Better Auth *throws* an `APIError` for a rejected credential — a
 * stray `x-api-key` trips its before-hook — and an unhandled throw reaches the
 * error handler as a 500 rather than the 401 it is. Any route resolving its own
 * session should come through here.
 */
export const resolveAuthSession = async (auth: Auth, headers: Headers) => {
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

// Better Auth adds the `__Secure-` prefix whenever cookies are secure (HTTPS or
// production), so both spellings must match.
const sessionCookiePattern = /^(__Secure-)?better-auth\.session_token=/

/**
 * Older web builds send cookies on passkey ceremonies (before the challenge
 * header, the WebAuthn challenge rode one), so any old Better Auth session
 * cookie the browser still holds comes along. The bearer
 * plugin appends its own session cookie after it, Better Auth reads the first
 * one, and a valid bearer request 401s. A Better Auth hook can't fix this (the
 * bearer plugin reads the original headers), so the stale cookie is stripped
 * here. Only on bearer requests, so cookie-based flows like SSO are untouched.
 */
export const stripStaleSessionCookie = (request: Request): Request => {
  const authorization = request.headers.get('authorization')
  const cookie = request.headers.get('cookie')
  if (!cookie || !authorization?.toLowerCase().startsWith('bearer ')) {
    return request
  }
  const parts = cookie.split(';').map((part) => part.trim())
  if (!parts.some((part) => sessionCookiePattern.test(part))) {
    return request
  }
  const filtered = parts.filter((part) => part && !sessionCookiePattern.test(part)).join('; ')
  const headers = new Headers(request.headers)
  if (filtered) {
    headers.set('cookie', filtered)
  } else {
    headers.delete('cookie')
  }
  return new Request(request, { headers })
}

export const passkeyChallengeHeader = 'X-Passkey-Challenge'

// The passkey plugin's challenge cookie, `__Secure-` prefixed on HTTPS like the session cookie.
const passkeyChallengeCookiePattern = /^(__Secure-)?better-auth\.better-auth-passkey=[^;,\s]+$/

const challengeIssuingPaths = ['/passkey/generate-register-options', '/passkey/generate-authenticate-options']

/**
 * The WebAuthn challenge rides a signed cookie, which the Apple apps' webview
 * never stores: `tauri://localhost` makes every API call cross-site. So the
 * challenge-issuing responses also carry the cookie in a header, for the client
 * to send back on the verify call.
 */
export const exposePasskeyChallenge = (pathname: string, response: Response): Response => {
  if (!challengeIssuingPaths.some((path) => pathname.endsWith(path))) {
    return response
  }
  const cookie = response.headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(';')[0].trim())
    .find((pair) => passkeyChallengeCookiePattern.test(pair))
  if (!cookie) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set(passkeyChallengeHeader, cookie)
  // The response's own list wins over the CORS defaults, so merge rather than overwrite.
  const exposed = headers.get('access-control-expose-headers')
  headers.set(
    'access-control-expose-headers',
    exposed ? `${exposed}, ${passkeyChallengeHeader}` : passkeyChallengeHeader,
  )
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * On the verify calls, turn a relayed challenge header back into the cookie
 * Better Auth reads. Only the challenge cookie is accepted, so the header can't
 * smuggle in any other.
 */
export const restorePasskeyChallenge = (pathname: string, request: Request): Request => {
  if (!passkeyVerifyPaths.some((path) => pathname.endsWith(path))) {
    return request
  }
  const challenge = request.headers.get(passkeyChallengeHeader)
  if (!challenge || !passkeyChallengeCookiePattern.test(challenge)) {
    return request
  }
  const headers = new Headers(request.headers)
  const cookie = headers.get('cookie')
  headers.set('cookie', cookie ? `${cookie}; ${challenge}` : challenge)
  headers.delete(passkeyChallengeHeader)
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
  // Mounted at Better Auth's basePath (under the app's /v1 prefix), not '/*': Better Auth
  // routes on whatever follows the first /api/auth, so a catch-all would let a lookalike
  // path like /v1/x/v1/api/auth/sign-in/anonymous reach it and skip the path-keyed limits.
  plugin.all(
    '/api/auth/*',
    async ({ request }) => {
      const { pathname } = new URL(request.url)
      if (!pathname.includes('/passkey/')) {
        return auth.handler(request)
      }
      return exposePasskeyChallenge(
        pathname,
        await auth.handler(stripStaleSessionCookie(restorePasskeyChallenge(pathname, request))),
      )
    },
    { parse: 'none' },
  )

  return { plugin, auth }
}

export type { Auth }
