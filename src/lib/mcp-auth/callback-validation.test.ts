/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { validateMcpOAuthCallback } from './callback-validation'

const issuer = 'https://auth.example.com'
const nonce = 'nonce-abc'

describe('validateMcpOAuthCallback', () => {
  it('accepts a matching nonce and matching iss', () => {
    expect(
      validateMcpOAuthCallback({
        returnedState: nonce,
        returnedIss: issuer,
        storedNonce: nonce,
        storedIssuer: issuer,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: true })
  })

  it('accepts when the AS does not advertise iss and none is returned', () => {
    expect(
      validateMcpOAuthCallback({
        returnedState: nonce,
        returnedIss: null,
        storedNonce: nonce,
        storedIssuer: issuer,
        issParameterSupported: false,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a null stored nonce (assert-and-reject, never short-circuit to accept)', () => {
    const result = validateMcpOAuthCallback({
      returnedState: nonce,
      returnedIss: issuer,
      storedNonce: null,
      storedIssuer: issuer,
      issParameterSupported: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects when the returned state is null even if a nonce was stored', () => {
    const result = validateMcpOAuthCallback({
      returnedState: null,
      returnedIss: issuer,
      storedNonce: nonce,
      storedIssuer: issuer,
      issParameterSupported: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a mismatched nonce', () => {
    const result = validateMcpOAuthCallback({
      returnedState: 'attacker-state',
      returnedIss: issuer,
      storedNonce: nonce,
      storedIssuer: issuer,
      issParameterSupported: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a mismatched iss', () => {
    const result = validateMcpOAuthCallback({
      returnedState: nonce,
      returnedIss: 'https://evil.example.com',
      storedNonce: nonce,
      storedIssuer: issuer,
      issParameterSupported: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects an absent iss when the AS advertised iss support', () => {
    const result = validateMcpOAuthCallback({
      returnedState: nonce,
      returnedIss: null,
      storedNonce: nonce,
      storedIssuer: issuer,
      issParameterSupported: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a mismatched iss even when the AS did not advertise iss support', () => {
    const result = validateMcpOAuthCallback({
      returnedState: nonce,
      returnedIss: 'https://evil.example.com',
      storedNonce: nonce,
      storedIssuer: issuer,
      issParameterSupported: false,
    })
    expect(result.ok).toBe(false)
  })
})
