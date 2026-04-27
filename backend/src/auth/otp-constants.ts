/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** OTP expiry duration in seconds — used by Better Auth emailOTP config. */
export const otpExpirySeconds = 600 // 10 minutes

/** OTP expiry duration in milliseconds — used for challenge token expiry and cooldown. */
export const otpExpiryMs = otpExpirySeconds * 1000

/** HTTP header name for challenge token session binding. */
export const challengeTokenHeader = 'x-challenge-token'
