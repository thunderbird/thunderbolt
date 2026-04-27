/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHmac } from 'crypto'
import { describe, expect, it } from 'bun:test'
import { verifySignedBearerToken } from './bearer-token'

const secret = 'test-secret-at-least-32-chars-long!!'

const sign = (token: string, s = secret): string => {
  const sig = createHmac('sha256', s).update(token).digest('base64')
  return `${token}.${sig}`
}

describe('verifySignedBearerToken', () => {
  it('returns raw token for a valid signed token', () => {
    expect(verifySignedBearerToken(sign('my-session-token'), secret)).toBe('my-session-token')
  })

  it('returns null when signed with wrong secret', () => {
    const signed = sign('my-session-token', 'wrong-secret-at-least-32-chars-long!!')
    expect(verifySignedBearerToken(signed, secret)).toBeNull()
  })

  it('returns null when token has no dot', () => {
    expect(verifySignedBearerToken('no-dot-token', secret)).toBeNull()
  })

  it('returns null for empty signature (token.)', () => {
    expect(verifySignedBearerToken('my-token.', secret)).toBeNull()
  })

  it('returns null for signature with incorrect length', () => {
    expect(verifySignedBearerToken('my-token.dG9vc2hvcnQ', secret)).toBeNull()
  })

  it('returns null for dot-only input', () => {
    expect(verifySignedBearerToken('.', secret)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(verifySignedBearerToken('', secret)).toBeNull()
  })

  it('handles token that itself contains dots', () => {
    const token = 'part1.part2.part3'
    const signed = sign(token)
    expect(verifySignedBearerToken(signed, secret)).toBe(token)
  })
})
