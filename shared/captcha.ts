/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Request header carrying the client's captcha solution on anonymous sign-in. */
export const captchaTokenHeader = 'x-captcha-token'

/** Error code of the 403 the anonymous sign-in answers when the captcha solution is refused. */
export const captchaVerificationFailedCode = 'CAPTCHA_VERIFICATION_FAILED'
