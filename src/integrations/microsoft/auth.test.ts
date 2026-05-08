/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MisconfiguredOAuthError } from '@/lib/auth'
import { createClient, type HttpClient } from '@/lib/http'
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildAuthUrl, resetBackendConfigCacheForTests } from './auth'

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

describe('Microsoft buildAuthUrl', () => {
  beforeEach(() => {
    resetBackendConfigCacheForTests()
  })

  it('throws MisconfiguredOAuthError with both-missing message when client_id is empty', async () => {
    const { client } = createMockHttpClient([{ client_id: '', configured: false }])
    const err = await buildAuthUrl(client, 'state', 'cc').catch((e) => e)
    expect(err).toBeInstanceOf(MisconfiguredOAuthError)
    expect((err as MisconfiguredOAuthError).missing).toBe('both')
    expect(err.message).toContain('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET')
  })

  it('throws MisconfiguredOAuthError with secret-only message when client_id is set but configured=false', async () => {
    const { client } = createMockHttpClient([{ client_id: 'real-id', configured: false }])
    const err = await buildAuthUrl(client, 'state', 'cc').catch((e) => e)
    expect(err).toBeInstanceOf(MisconfiguredOAuthError)
    expect((err as MisconfiguredOAuthError).missing).toBe('secret')
    expect(err.message).toContain('Set MICROSOFT_CLIENT_SECRET')
    expect(err.message).not.toContain('MICROSOFT_CLIENT_ID and')
  })

  it('produces a valid authorization URL when configured', async () => {
    const { client } = createMockHttpClient([{ client_id: 'real-id', configured: true }])
    const url = new URL(await buildAuthUrl(client, 'state-xyz', 'cc-abc'))
    expect(url.host).toBe('login.microsoftonline.com')
    expect(url.searchParams.get('client_id')).toBe('real-id')
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('code_challenge')).toBe('cc-abc')
  })

  it('refetches /config after a configured: false response (no stale cache)', async () => {
    const { client, callCount } = createMockHttpClient([
      { client_id: '', configured: false },
      { client_id: 'now-set', configured: true },
    ])
    await buildAuthUrl(client, 'state', 'cc').catch(() => {})
    const url = new URL(await buildAuthUrl(client, 'state', 'cc'))
    expect(url.searchParams.get('client_id')).toBe('now-set')
    expect(callCount()).toBe(2)
  })

  it('reuses cache after a configured: true response', async () => {
    const { client, callCount } = createMockHttpClient([{ client_id: 'real-id', configured: true }])
    await buildAuthUrl(client, 'state', 'cc')
    await buildAuthUrl(client, 'state2', 'cc2')
    expect(callCount()).toBe(1)
  })
})
