/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { Elysia, type AnyElysia } from 'elysia'
import { createAltchaChallenge } from './captcha'

/**
 * `GET /captcha/challenge`: the unauthenticated endpoint that serves an ALTCHA challenge for
 * anonymous sign-in. The app fetches it through its HttpClient, which sends `X-App-Version`,
 * so it stays behind the version gate like the sign-in it precedes. A sibling of the Better
 * Auth mount rather than inside `/api/auth/*`, which Better Auth's router owns. Not mounted
 * unless CAPTCHA_PROVIDER=altcha.
 */
export const createCaptchaRoutes = (
  settings: Pick<Settings, 'captchaProvider' | 'captchaSecret' | 'captchaDifficulty' | 'captchaTtlSecs'>,
  ipRateLimit: AnyElysia,
) => {
  if (settings.captchaProvider !== 'altcha') {
    return new Elysia({ name: 'captcha-routes' })
  }
  return new Elysia({ name: 'captcha-routes', prefix: '/captcha' }).use(ipRateLimit).get('/challenge', ({ set }) => {
    // Each challenge redeems once; a cached copy would fail sign-in with 403.
    set.headers['Cache-Control'] = 'no-store'
    set.headers['Pragma'] = 'no-cache'
    return createAltchaChallenge(settings)
  })
}
