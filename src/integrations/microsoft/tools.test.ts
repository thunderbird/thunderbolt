/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isTokenFresh } from './tools'

describe('isTokenFresh', () => {
  const now = 1_700_000_000_000

  it('returns true when token has more than 60 seconds until expiry', () => {
    const expiresAt = now + 120_000
    expect(isTokenFresh(expiresAt, now)).toBe(true)
  })

  it('returns false when token has less than 60 seconds until expiry', () => {
    const expiresAt = now + 30_000
    expect(isTokenFresh(expiresAt, now)).toBe(false)
  })

  it('returns false when token has exactly 60 seconds until expiry', () => {
    const expiresAt = now + 60_000
    expect(isTokenFresh(expiresAt, now)).toBe(false)
  })

  it('returns true when token has 61 seconds until expiry', () => {
    const expiresAt = now + 61_000
    expect(isTokenFresh(expiresAt, now)).toBe(true)
  })

  it('returns false when token is already expired', () => {
    const expiresAt = now - 10_000
    expect(isTokenFresh(expiresAt, now)).toBe(false)
  })

  it('returns false when expires_at is undefined', () => {
    expect(isTokenFresh(undefined, now)).toBe(false)
  })
})
