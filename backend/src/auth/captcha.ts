/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'

/** Request header carrying the client's captcha solution. */
export const captchaTokenHeader = 'x-captcha-token'

/** Request details beyond the solution. Turnstile's `remoteip` needs the client IP from the headers; ALTCHA may not. */
export type CaptchaContext = {
  headers: Headers | undefined
}

/** Verifies a captcha solution submitted with a bot-sensitive request (e.g. anonymous sign-in). */
export type CaptchaVerifier = {
  verify: (payload: string | null, context: CaptchaContext) => Promise<boolean>
}

const noneVerifier: CaptchaVerifier = {
  verify: async () => true,
}

/**
 * Build the verifier for the configured CAPTCHA_PROVIDER. 'none' always passes, leaving
 * the IP rate limits as the only bot control.
 */
export const createCaptchaVerifier = (settings: Pick<Settings, 'captchaProvider'>): CaptchaVerifier => {
  if (settings.captchaProvider === 'none') {
    return noneVerifier
  }
  // TODO(THU-113): ALTCHA proof-of-work verifier (Turnstile later). Fail at startup rather
  // than silently accepting every request while the provider is configured but unbuilt.
  throw new Error(`CAPTCHA_PROVIDER=${settings.captchaProvider} is not supported yet`)
}
