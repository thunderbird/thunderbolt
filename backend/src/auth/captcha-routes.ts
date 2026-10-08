/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { Elysia, type AnyElysia } from 'elysia'
import { createAltchaChallenge } from './captcha'

/**
 * `GET /captcha/challenge`: the unauthenticated endpoint the ALTCHA widget fetches before
 * anonymous sign-in. A sibling of the Better Auth mount rather than inside `/api/auth/*`,
 * which Better Auth's router owns. Not mounted unless CAPTCHA_PROVIDER=altcha.
 */
export const createCaptchaRoutes = (
  settings: Pick<Settings, 'captchaProvider' | 'captchaSecret' | 'captchaDifficulty' | 'captchaTtlSecs'>,
  ipRateLimit: AnyElysia,
) => {
  if (settings.captchaProvider !== 'altcha') {
    return new Elysia({ name: 'captcha-routes' })
  }
  return new Elysia({ name: 'captcha-routes', prefix: '/captcha' })
    .use(ipRateLimit)
    .get('/challenge', () => createAltchaChallenge(settings))
}
