/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MisconfiguredOAuthError } from '@/lib/auth'
import { createClient, type HttpClient } from '@/lib/http'
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildAuthUrl, getUserInfo, resetBackendConfigCacheForTests, revokeTokens } from './auth'

const createMockHttpClient = (responses: unknown[]): { client: HttpClient; callCount: () => number } => {
  let callCount = 0
  const mockFetch = async (): Promise<Response> => {
    const response = responses[callCount] ?? responses[responses.length - 1]
    callCount++
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return {
    client: createClient({ prefixUrl: 'http://localhost/', fetch: mockFetch }),
    callCount: () => callCount,
  }
}

describe('Tinfoil buildAuthUrl', () => {
  beforeEach(() => {
    resetBackendConfigCacheForTests()
  })

  it('throws a public-client misconfig message (client_id only, no secret) when unconfigured', async () => {
    const { client } = createMockHttpClient([{ client_id: '', configured: false }])
    const err = await buildAuthUrl(client, 'state', 'cc').catch((e) => e)
    expect(err).toBeInstanceOf(MisconfiguredOAuthError)
    expect(err.message).toContain('Set TINFOIL_CLIENT_ID')
    expect(err.message).not.toContain('SECRET')
  })

  it('produces a valid Tinfoil authorization URL when configured', async () => {
    const { client } = createMockHttpClient([{ client_id: 'oauthc_test', configured: true }])
    const url = new URL(await buildAuthUrl(client, 'state-xyz', 'cc-abc'))
    expect(url.host).toBe('dash.tinfoil.sh')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('oauthc_test')
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('code_challenge')).toBe('cc-abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('inference:api offline_access')
  })

  it('honors a runtime redirect_uri override (loopback flow)', async () => {
    const { client } = createMockHttpClient([{ client_id: 'oauthc_test', configured: true }])
    const url = new URL(await buildAuthUrl(client, 'state', 'cc', 'http://localhost:17421'))
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:17421')
  })

  it('reuses cache after a configured: true response', async () => {
    const { client, callCount } = createMockHttpClient([{ client_id: 'oauthc_test', configured: true }])
    await buildAuthUrl(client, 'state', 'cc')
    await buildAuthUrl(client, 'state2', 'cc2')
    expect(callCount()).toBe(1)
  })

  it('refetches /config after a configured: false response (no stale cache)', async () => {
    const { client, callCount } = createMockHttpClient([
      { client_id: '', configured: false },
      { client_id: 'oauthc_now', configured: true },
    ])
    await buildAuthUrl(client, 'state', 'cc').catch(() => {})
    const url = new URL(await buildAuthUrl(client, 'state', 'cc'))
    expect(url.searchParams.get('client_id')).toBe('oauthc_now')
    expect(callCount()).toBe(2)
  })
})

describe('Tinfoil getUserInfo', () => {
  it('returns a static identity (no userinfo endpoint for inference:api)', async () => {
    const info = await getUserInfo('any-token')
    expect(info.name).toBe('Tinfoil')
    expect(info.id).toBe('tinfoil')
  })
})

describe('Tinfoil revokeTokens', () => {
  it('resolves when the backend confirms revocation', async () => {
    const { client } = createMockHttpClient([{ revoked: true }])
    const result = await revokeTokens(client, 'rt').catch((e) => e)
    expect(result).toBeUndefined()
  })

  it('throws when the backend returns 200 but { revoked: false } (not actually revoked)', async () => {
    const { client } = createMockHttpClient([{ revoked: false }])
    const err = await revokeTokens(client, 'rt').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('was not confirmed')
  })
})
