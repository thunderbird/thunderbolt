/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sanitizeErrorForTracking } from './sync-tracker'

describe('sanitizeErrorForTracking', () => {
  it('redacts email addresses', () => {
    expect(sanitizeErrorForTracking('Error for user@example.com')).toBe('Error for [EMAIL]')
  })

  it('redacts UUIDs', () => {
    expect(sanitizeErrorForTracking('Failed for 550e8400-e29b-41d4-a716-446655440000')).toBe('Failed for [UUID]')
  })

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_signature'
    expect(sanitizeErrorForTracking(`Token: ${jwt}`)).toBe('Token: [JWT]')
  })

  it('redacts multiple PII types in one string', () => {
    const error = 'User user@test.com (550e8400-e29b-41d4-a716-446655440000) failed'
    expect(sanitizeErrorForTracking(error)).toBe('User [EMAIL] ([UUID]) failed')
  })

  it('truncates long strings after redaction', () => {
    const longError = 'E'.repeat(300)
    const result = sanitizeErrorForTracking(longError)
    expect(result.length).toBeLessThanOrEqual(201) // 200 + ellipsis
  })

  it('passes through clean error strings unchanged', () => {
    expect(sanitizeErrorForTracking('Connection timeout')).toBe('Connection timeout')
  })
})
