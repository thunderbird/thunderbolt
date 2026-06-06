/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createClient } from '@/lib/http'
import { ensureValidOAuthToken, isTokenFresh } from './oauth-credentials'

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

describe('ensureValidOAuthToken', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  /** Mock HTTP client whose /refresh always returns a freshly rotated token set. */
  const refreshingHttpClient = (rotated: { access_token: string; refresh_token: string; expires_in: number }) =>
    createClient({
      prefixUrl: 'http://localhost/',
      fetch: async () =>
        new Response(JSON.stringify({ ...rotated, token_type: 'Bearer' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })

  it('returns the cached access token without refreshing when still fresh', async () => {
    await saveIntegrationCredentials(
      getDb(),
      'tinfoil',
      { access_token: 'fresh.access', refresh_token: 'r1', expires_at: Date.now() + 10 * 60_000 },
      true,
    )
    const client = refreshingHttpClient({ access_token: 'should.not.be.used', refresh_token: 'r2', expires_in: 900 })

    const token = await ensureValidOAuthToken(client, 'tinfoil', {
      access_token: 'fresh.access',
      refresh_token: 'r1',
      expires_at: Date.now() + 10 * 60_000,
    })

    expect(token).toBe('fresh.access')
  })

  it('refreshes an expired token and PERSISTS the rotated refresh token', async () => {
    // Tinfoil rotates the refresh token on every use and revokes the whole family
    // if a spent token is replayed — so the rotated value must be stored.
    const expired = { access_token: 'old.access', refresh_token: 'rotating-1', expires_at: Date.now() - 60_000 }
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)

    const client = refreshingHttpClient({ access_token: 'new.access', refresh_token: 'rotating-2', expires_in: 900 })
    const token = await ensureValidOAuthToken(client, 'tinfoil', expired)

    expect(token).toBe('new.access')

    const stored = await getIntegrationCredentials(getDb(), 'tinfoil')
    expect(stored?.credentials.access_token).toBe('new.access')
    expect(stored?.credentials.refresh_token).toBe('rotating-2')
  })
})
