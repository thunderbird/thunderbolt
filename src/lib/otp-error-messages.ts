/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

type OtpError = { code?: string; message?: string }
type OtpErrorContext = 'link' | 'code'

// `msg` (not `t`) because these live at module scope: `t` resolves against the
// active catalog where it is evaluated, so a module-scope `t` would freeze the
// locale at import time and never follow a language change. `msg` records a
// descriptor and leaves resolution to `i18n._` at render.
const messages: Record<OtpErrorContext, Record<string, MessageDescriptor>> = {
  link: {
    OTP_EXPIRED: msg`This link has expired. Please request a new one.`,
    INVALID_OTP: msg`This link is invalid. Please request a new one.`,
    TOO_MANY_ATTEMPTS: msg`Too many attempts. Please request a new code.`,
  },
  code: {
    OTP_EXPIRED: msg`This code has expired. Please request a new one.`,
    INVALID_OTP: msg`Invalid code. Please try again.`,
    TOO_MANY_ATTEMPTS: msg`Too many attempts. Please request a new code.`,
  },
}

const fallback = msg`Verification failed. Please try again.`

/**
 * Returns a user-facing message for OTP verification errors.
 * Handles OTP_EXPIRED, INVALID_OTP, and TOO_MANY_ATTEMPTS from Better Auth.
 *
 * Returns a descriptor rather than a string so the caller resolves it with
 * `i18n._` at render time — callers hold this in reducer/component state, and a
 * string would be stuck in whatever locale was active when the error happened.
 */
export const getOtpErrorMessage = (error: OtpError, context: OtpErrorContext): MessageDescriptor => {
  const message = error?.code ? messages[context][error.code] : undefined
  if (message) {
    return message
  }
  // Better Auth's own message for codes we don't map. Wrapped as a descriptor
  // with no catalog entry so callers have a single type to render: `i18n._`
  // returns `message` verbatim when the id misses.
  return error?.message ? { id: error.message, message: error.message } : fallback
}
