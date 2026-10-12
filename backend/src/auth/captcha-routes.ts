/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia } from 'elysia'
import type { CaptchaProvider } from './captcha'

type CaptchaRoutesDeps = {
  provider: CaptchaProvider
  authAllowAnonymous: boolean
  /** Called only when the route mounts, so a deployment without it builds no limiter. */
  createIpRateLimit: () => AnyElysia
}

/**
 * `GET /captcha/challenge`: the unauthenticated endpoint that serves a captcha challenge for
 * anonymous sign-in. Mounted only when the provider issues challenges (ALTCHA does, `none`
 * does not) and anonymous auth is on. No client calls it yet: the app has no ALTCHA support,
 * so enabling the provider refuses every anonymous sign-in. It stays behind the version gate
 * like the sign-in it precedes, so the client must fetch it through the HttpClient, which
 * sends `X-App-Version`. A sibling of the Better Auth mount rather than inside `/api/auth/*`,
 * which Better Auth's router owns.
 */
export const createCaptchaRoutes = ({ provider, authAllowAnonymous, createIpRateLimit }: CaptchaRoutesDeps) => {
  const { issueChallenge } = provider
  if (!issueChallenge || !authAllowAnonymous) {
    return new Elysia({ name: 'captcha-routes' })
  }
  return new Elysia({ name: 'captcha-routes', prefix: '/captcha' })
    .onError(safeErrorHandler)
    .use(createIpRateLimit())
    .get('/challenge', ({ set }) => {
      // Each challenge redeems once; a cached copy would fail sign-in with 403.
      set.headers['Cache-Control'] = 'no-store'
      return issueChallenge()
    })
}
