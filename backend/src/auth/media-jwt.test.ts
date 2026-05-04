/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, SignJWT } from 'jose'
import { __resetMediaJwtCacheForTests, MEDIA_JWT_ALGORITHMS, MEDIA_JWT_AUDIENCE, verifyMediaJwt } from './media-jwt'

/** Build a JWKS pair (private key for signing, public JSONWebKeySet for verify). */
const buildJwksFixture = async (kid = 'test-kid') => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true, crv: 'Ed25519' })
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid }
  return { privateKey, publicJwk, jwks: { keys: [publicJwk] } as JSONWebKeySet }
}

const signTestToken = async (
  privateKey: CryptoKey,
  claims: { sub?: string; aud?: string | string[]; exp?: number; nbf?: number; kid?: string } = {},
) => {
  const sub = claims.sub ?? 'user-42'
  const exp = claims.exp ?? Math.floor(Date.now() / 1000) + 600
  const aud = claims.aud ?? MEDIA_JWT_AUDIENCE
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: claims.kid ?? 'test-kid' })
    .setSubject(sub)
    .setAudience(aud)
    .setExpirationTime(exp)
  if (claims.nbf) builder.setNotBefore(claims.nbf)
  return builder.sign(privateKey)
}

describe('verifyMediaJwt', () => {
  afterEach(() => {
    __resetMediaJwtCacheForTests()
  })

  it('returns user.id for a valid token (audience match, unexpired)', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    const token = await signTestToken(privateKey, { sub: 'user-42' })
    const auth = { api: { getJwks: async () => jwks } } as never
    const result = await verifyMediaJwt(token, auth)
    expect(result).toEqual({ user: { id: 'user-42' } })
  })

  it('returns null for an expired token', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    // Expire 30s ago — past the 10s clock tolerance
    const token = await signTestToken(privateKey, { exp: Math.floor(Date.now() / 1000) - 30 })
    const auth = { api: { getJwks: async () => jwks } } as never
    expect(await verifyMediaJwt(token, auth)).toBeNull()
  })

  it('accepts a token expired 5s ago (within 10s clock tolerance)', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    const token = await signTestToken(privateKey, { exp: Math.floor(Date.now() / 1000) - 5 })
    const auth = { api: { getJwks: async () => jwks } } as never
    const result = await verifyMediaJwt(token, auth)
    expect(result).toEqual({ user: { id: 'user-42' } })
  })

  it('returns null for a wrong-audience token', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    const token = await signTestToken(privateKey, { aud: 'some-other-service' })
    const auth = { api: { getJwks: async () => jwks } } as never
    expect(await verifyMediaJwt(token, auth)).toBeNull()
  })

  it('returns null for a token signed by an unknown kid (after refresh fails)', async () => {
    const { privateKey } = await buildJwksFixture('rotated-kid')
    // Auth returns an empty key set — no kid will match
    const auth = { api: { getJwks: async () => ({ keys: [] }) as JSONWebKeySet } } as never
    const token = await signTestToken(privateKey, { kid: 'rotated-kid' })
    expect(await verifyMediaJwt(token, auth)).toBeNull()
  })

  it('returns null for a malformed token', async () => {
    const auth = { api: { getJwks: async () => ({ keys: [] }) as JSONWebKeySet } } as never
    expect(await verifyMediaJwt('not.a.token', auth)).toBeNull()
    expect(await verifyMediaJwt('', auth)).toBeNull()
  })

  it('returns null when the payload has no sub claim', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    // Manually craft a token without sub via SignJWT (omit setSubject).
    const exp = Math.floor(Date.now() / 1000) + 600
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid' })
      .setAudience(MEDIA_JWT_AUDIENCE)
      .setExpirationTime(exp)
      .sign(privateKey)
    const auth = { api: { getJwks: async () => jwks } } as never
    expect(await verifyMediaJwt(token, auth)).toBeNull()
  })

  it('refreshes JWKS once on kid miss and accepts the rotated key', async () => {
    // Simulate rotation: first call to getJwks returns the OLD key set,
    // second call returns the NEW key set containing the kid the token uses.
    const oldFixture = await buildJwksFixture('old-kid')
    const newFixture = await buildJwksFixture('new-kid')
    let getJwksCalls = 0
    const auth = {
      api: {
        getJwks: async () => {
          getJwksCalls += 1
          return getJwksCalls === 1 ? oldFixture.jwks : newFixture.jwks
        },
      },
    } as never
    // First, prime the cache with an old-kid verify (succeeds)
    const oldToken = await signTestToken(oldFixture.privateKey, { kid: 'old-kid', sub: 'user-1' })
    expect(await verifyMediaJwt(oldToken, auth)).toEqual({ user: { id: 'user-1' } })

    // Now a new-kid token comes in — cache miss, refresh, retry, succeed
    const newToken = await signTestToken(newFixture.privateKey, { kid: 'new-kid', sub: 'user-2' })
    expect(await verifyMediaJwt(newToken, auth)).toEqual({ user: { id: 'user-2' } })
    expect(getJwksCalls).toBe(2)
  })

  it('caches JWKS across calls (one fetch for many verifies)', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    let getJwksCalls = 0
    const auth = {
      api: {
        getJwks: async () => {
          getJwksCalls += 1
          return jwks
        },
      },
    } as never
    const token = await signTestToken(privateKey)
    for (let i = 0; i < 5; i++) {
      await verifyMediaJwt(token, auth)
    }
    expect(getJwksCalls).toBe(1)
  })

  it('exposes the algorithm allowlist as EdDSA only (defense-in-depth pin)', () => {
    // If someone widens this, they MUST also update the JWKS keyPairConfig.
    expect([...MEDIA_JWT_ALGORITHMS]).toEqual(['EdDSA'])
  })

  it('rejects an HS256-signed token even if the JWKS contains a matching kid', async () => {
    // Defense-in-depth: jose's createLocalJWKSet would never accept an HS256
    // token in practice (no symmetric key in the set), but a hostile JWKS
    // injection or a future asymmetric algorithm with the same kid must NOT
    // bypass the EdDSA-only allowlist.
    const hs256Secret = new TextEncoder().encode('shared-secret-32-bytes-long-xxxxx')
    const exp = Math.floor(Date.now() / 1000) + 600
    // Manually craft an HS256 token signed with the symmetric secret.
    const hs256Token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'test-kid' })
      .setSubject('user-evil')
      .setAudience(MEDIA_JWT_AUDIENCE)
      .setExpirationTime(exp)
      .sign(hs256Secret)

    // Build an auth whose JWKS contains the matching kid + the symmetric key
    // (improbable but constructed to prove the algorithms allowlist guards us
    // even when the kid resolves successfully).
    const symmetricJwk: JWK = {
      kty: 'oct',
      k: Buffer.from(hs256Secret).toString('base64url'),
      alg: 'HS256',
      kid: 'test-kid',
    }
    const auth = {
      api: { getJwks: async () => ({ keys: [symmetricJwk] }) as JSONWebKeySet },
    } as never

    expect(await verifyMediaJwt(hs256Token, auth)).toBeNull()
  })

  it('handles concurrent verifies with a single JWKS fetch', async () => {
    const { privateKey, jwks } = await buildJwksFixture()
    let getJwksCalls = 0
    const auth = {
      api: {
        getJwks: async () => {
          getJwksCalls += 1
          // Resolve on next tick to expose any race condition
          await Promise.resolve()
          return jwks
        },
      },
    } as never
    const token = await signTestToken(privateKey)
    const results = await Promise.all([
      verifyMediaJwt(token, auth),
      verifyMediaJwt(token, auth),
      verifyMediaJwt(token, auth),
    ])
    for (const r of results) expect(r).toEqual({ user: { id: 'user-42' } })
    // Single in-flight refresh — no thundering herd.
    expect(getJwksCalls).toBe(1)
  })
})
