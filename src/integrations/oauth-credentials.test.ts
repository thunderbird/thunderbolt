/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import {
  getIntegrationCredentials,
  saveIntegrationCredentials,
  deleteIntegrationCredentials,
  setIntegrationEnabled,
} from '@/dal/integrations'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createClient } from '@/lib/http'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
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

describe('OAuth refresh without a cloud session', () => {
  beforeAll(setupTestDatabase)
  beforeEach(resetTestDatabase)
  afterEach(() => mock.restore())
  afterAll(teardownTestDatabase)
  const credentials = {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: 0,
    oauthRelayUrl: 'https://original.example/v1',
    profile: { email: 'user@example.com', name: 'User' },
  }

  it.each([undefined, 'rotated-refresh'])(
    'refreshes through the issuing relay and preserves or rotates the token: %s',
    async (refreshToken) => {
      await saveIntegrationCredentials(getDb(), 'google', credentials, true)
      useLocalSettingsStore.setState({ cloudUrl: 'https://other.example/v1' })
      const fetch = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: RequestInfo | URL) => {
            const request = new Request(input)
            expect(request.url).toBe('https://original.example/v1/auth/google/refresh')
            expect(request.headers.get('Authorization')).toBeNull()
            expect(request.credentials).toBe('omit')
            return Response.json({ access_token: 'new-access', refresh_token: refreshToken, expires_in: 3600 })
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      expect(await ensureValidOAuthToken(createClient(), 'google', credentials)).toBe('new-access')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect((await getIntegrationCredentials(getDb(), 'google'))?.credentials).toMatchObject({
        ...credentials,
        access_token: 'new-access',
        refresh_token: refreshToken ?? 'old-refresh',
        expires_at: expect.any(Number),
      })
    },
  )

  it.each(['disconnect', 'reconnect', 'disable'] as const)(
    'does not undo %s while a refresh is in flight',
    async (change) => {
      await saveIntegrationCredentials(getDb(), 'google', credentials, true)
      const response = Promise.withResolvers<Response>()
      spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(() => response.promise, { preconnect: globalThis.fetch.preconnect }),
      )
      const pending = ensureValidOAuthToken(createClient(), 'google', credentials)
      if (change === 'disconnect') {
        await deleteIntegrationCredentials(getDb(), 'google')
      }
      if (change === 'reconnect') {
        await saveIntegrationCredentials(getDb(), 'google', { ...credentials, access_token: 'different-account' }, true)
      }
      if (change === 'disable') {
        await setIntegrationEnabled(getDb(), 'google', false)
      }
      response.resolve(Response.json({ access_token: 'stale-access', expires_in: 3600 }))
      await expect(pending).rejects.toThrow('integration changed')
      const current = await getIntegrationCredentials(getDb(), 'google')
      expect(current?.credentials.access_token).not.toBe('stale-access')
      if (change === 'disconnect') {
        expect(current).toBeNull()
      }
      if (change === 'disable') {
        expect(current?.enabled).toBe(false)
      }
    },
  )
})
