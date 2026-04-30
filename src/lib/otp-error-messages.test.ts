/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getOtpErrorMessage } from './otp-error-messages'

describe('getOtpErrorMessage', () => {
  describe('link context', () => {
    it('returns link-specific message for OTP_EXPIRED', () => {
      expect(getOtpErrorMessage({ code: 'OTP_EXPIRED', message: 'OTP expired' }, 'link')).toBe(
        'This link has expired. Please request a new one.',
      )
    })

    it('returns link-specific message for INVALID_OTP', () => {
      expect(getOtpErrorMessage({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 'link')).toBe(
        'This link is invalid. Please request a new one.',
      )
    })

    it('returns message for TOO_MANY_ATTEMPTS', () => {
      expect(getOtpErrorMessage({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' }, 'link')).toBe(
        'Too many attempts. Please request a new code.',
      )
    })
  })

  describe('code context', () => {
    it('returns code-specific message for OTP_EXPIRED', () => {
      expect(getOtpErrorMessage({ code: 'OTP_EXPIRED', message: 'OTP expired' }, 'code')).toBe(
        'This code has expired. Please request a new one.',
      )
    })

    it('returns code-specific message for INVALID_OTP', () => {
      expect(getOtpErrorMessage({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 'code')).toBe(
        'Invalid code. Please try again.',
      )
    })

    it('returns message for TOO_MANY_ATTEMPTS', () => {
      expect(getOtpErrorMessage({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' }, 'code')).toBe(
        'Too many attempts. Please request a new code.',
      )
    })
  })

  describe('fallbacks', () => {
    it('uses error.message when code is unknown', () => {
      expect(getOtpErrorMessage({ code: 'UNKNOWN', message: 'Custom message' }, 'link')).toBe('Custom message')
    })

    it('uses fallback when error has no code or message', () => {
      expect(getOtpErrorMessage({}, 'link')).toBe('Verification failed. Please try again.')
    })
  })
})
