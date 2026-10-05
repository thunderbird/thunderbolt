/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'

/** Request header carrying the client's captcha solution. */
export const captchaTokenHeader = 'x-captcha-token'

/**
 * Request details beyond the solution. `clientIp` is resolved once by the caller from the
 * trusted proxy setting, so verifiers never decide which header to trust (Turnstile's
 * `remoteip` needs it; ALTCHA may not). 'unknown' when no trusted header is present.
 */
export type CaptchaContext = {
  clientIp: string
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
  // TODO(THU-113): ALTCHA proof-of-work verifier, added to the CAPTCHA_PROVIDER enum with it.
  switch (settings.captchaProvider) {
    case 'none':
      return noneVerifier
  }
}
