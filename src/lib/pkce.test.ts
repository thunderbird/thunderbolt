/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'

describe('generateCodeVerifier', () => {
  it('generates a valid code verifier', () => {
    const verifier = generateCodeVerifier()

    // Should be a non-empty string
    expect(verifier).toBeTruthy()
    expect(typeof verifier).toBe('string')

    // Should be URL-safe (no +, /, or = characters)
    expect(verifier).not.toMatch(/[+/=]/)

    // Should be base64url encoded (43-128 characters as per RFC 7636)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('generates unique verifiers on each call', () => {
    const verifier1 = generateCodeVerifier()
    const verifier2 = generateCodeVerifier()
    const verifier3 = generateCodeVerifier()

    expect(verifier1).not.toBe(verifier2)
    expect(verifier2).not.toBe(verifier3)
    expect(verifier1).not.toBe(verifier3)
  })
})

describe('generateCodeChallenge', () => {
  it('generates a valid code challenge from a verifier', async () => {
    const verifier = generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)

    // Should be a non-empty string
    expect(challenge).toBeTruthy()
    expect(typeof challenge).toBe('string')

    // Should be URL-safe (no +, /, or = characters)
    expect(challenge).not.toMatch(/[+/=]/)

    // SHA-256 hash encoded as base64url should be 43 characters
    expect(challenge.length).toBe(43)
  })

  it('generates the same challenge for the same verifier', async () => {
    const verifier = 'test-verifier-12345'
    const challenge1 = await generateCodeChallenge(verifier)
    const challenge2 = await generateCodeChallenge(verifier)

    expect(challenge1).toBe(challenge2)
  })

  it('generates different challenges for different verifiers', async () => {
    const verifier1 = 'test-verifier-1'
    const verifier2 = 'test-verifier-2'
    const challenge1 = await generateCodeChallenge(verifier1)
    const challenge2 = await generateCodeChallenge(verifier2)

    expect(challenge1).not.toBe(challenge2)
  })

  it('handles empty string', async () => {
    const challenge = await generateCodeChallenge('')

    expect(challenge).toBeTruthy()
    expect(typeof challenge).toBe('string')
    expect(challenge.length).toBe(43)
  })
})

describe('PKCE flow integration', () => {
  it('verifier and challenge work together', async () => {
    const verifier = generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)

    // Both should be valid strings
    expect(verifier).toBeTruthy()
    expect(challenge).toBeTruthy()

    // Challenge should be derived from verifier
    const challengeAgain = await generateCodeChallenge(verifier)
    expect(challenge).toBe(challengeAgain)
  })
})
