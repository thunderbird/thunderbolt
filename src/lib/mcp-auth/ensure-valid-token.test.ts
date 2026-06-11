/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mcpServersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { ensureValidMcpOAuthToken, McpOAuthNeedsReauthError } from './ensure-valid-token'

type RefreshFn = typeof refreshAuthorization

const serverId = 'server-1'
const serverUrl = 'https://mcp.example.com/sse'
const issuer = 'https://auth.example.com'
const tokenEndpoint = 'https://auth.example.com/token'

const neverCalledFetch: FetchLike = () => {
  throw new Error('fetch should not be called')
}

const seedServer = async () => {
  await getDb().insert(mcpServersTable).values({
    id: serverId,
    name: 'OAuth Server',
    type: 'sse',
    url: serverUrl,
    enabled: 1,
  })
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('ensureValidMcpOAuthToken', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('returns the access token without refreshing when fresh', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'fresh-token',
      refresh_token: 'r1',
      expires_at: Date.now() + 600_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    let called = false
    const refresh: RefreshFn = async () => {
      called = true
      return { access_token: 'unused', token_type: 'Bearer' }
    }

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)
    expect(token).toBe('fresh-token')
    expect(called).toBe(false)
  })

  it('treats a token with no expiry as fresh (never force-refreshes)', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'no-expiry-token',
      refresh_token: 'r1',
      // no expires_at — a non-expiring token must be reused as-is.
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    let called = false
    const refresh: RefreshFn = async () => {
      called = true
      return { access_token: 'unused', token_type: 'Bearer' }
    }

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)
    expect(token).toBe('no-expiry-token')
    expect(called).toBe(false)
  })

  it('refreshes a stale token, rotates the refresh token, and recomputes expiry', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale-token',
      refresh_token: 'old-refresh',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
      scope: 'read',
    })

    let capturedResource: string | undefined
    let capturedRefreshToken: string | undefined
    let capturedAuthServer: string | undefined
    const refresh: RefreshFn = async (authServerUrl, opts) => {
      capturedAuthServer = String(authServerUrl)
      capturedResource = opts.resource?.href
      capturedRefreshToken = opts.refreshToken
      const tokens: OAuthTokens = {
        access_token: 'new-token',
        token_type: 'Bearer',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }
      return tokens
    }

    const before = Date.now()
    const token = await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)
    expect(token).toBe('new-token')
    expect(capturedAuthServer).toBe(issuer)
    expect(capturedRefreshToken).toBe('old-refresh')
    // RFC 8707 resource = canonical MCP server URL.
    expect(capturedResource).toBe(new URL(serverUrl).href)

    const stored = await getMcpServerCredentials(getDb(), serverId)
    if (stored?.type !== 'oauth') {
      throw new Error('expected oauth credentials')
    }
    expect(stored.access_token).toBe('new-token')
    // Rotation: the new refresh token replaces the old one.
    expect(stored.refresh_token).toBe('new-refresh')
    expect(stored.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000)
    // Untouched fields are preserved.
    expect(stored.clientId).toBe('client-1')
    expect(stored.issuer).toBe(issuer)
    expect(stored.scope).toBe('read')
  })

  it('stores a refresh response without expires_in as non-expiring (no refresh storm)', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'r1',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    // Some authorization servers omit expires_in on refresh; the token must then
    // be treated as non-expiring, not pinned to the already-past timestamp.
    const refresh: RefreshFn = async () => ({ access_token: 'refreshed', token_type: 'Bearer' })

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)
    expect(token).toBe('refreshed')

    const stored = await getMcpServerCredentials(getDb(), serverId)
    if (stored?.type !== 'oauth') {
      throw new Error('expected oauth credentials')
    }
    expect(stored.access_token).toBe('refreshed')
    expect(stored.expires_at).toBeUndefined()
  })

  it('coalesces concurrent refreshes for the same server into a single refresh', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'rotating',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    let refreshCalls = 0
    const refresh: RefreshFn = async () => {
      refreshCalls += 1
      // A rotating-refresh-token AS would reject a second presentation with
      // invalid_grant; coalescing means it is only ever presented once.
      return { access_token: 'fresh', token_type: 'Bearer', refresh_token: 'rotated', expires_in: 3600 }
    }

    const [a, b] = await Promise.all([
      ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh),
      ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh),
    ])

    expect(a).toBe('fresh')
    expect(b).toBe('fresh')
    expect(refreshCalls).toBe(1)
  })

  it('evicts a failed refresh so a later call retries instead of replaying it', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'r1',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    let attempt = 0
    const refresh: RefreshFn = async () => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('transient network failure')
      }
      return { access_token: 'recovered', token_type: 'Bearer', expires_in: 3600 }
    }

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)).rejects.toThrow(
      'transient network failure',
    )
    // The failed promise was evicted, so this call performs a fresh refresh.
    const token = await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)
    expect(token).toBe('recovered')
    expect(attempt).toBe(2)
  })

  it('preserves the existing refresh token when the AS omits a new one', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'keep-refresh',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => ({ access_token: 'rotated', token_type: 'Bearer', expires_in: 1200 })

    await ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)

    const stored = await getMcpServerCredentials(getDb(), serverId)
    if (stored?.type !== 'oauth') {
      throw new Error('expected oauth credentials')
    }
    expect(stored.access_token).toBe('rotated')
    expect(stored.refresh_token).toBe('keep-refresh')
  })

  it('maps invalid_grant to McpOAuthNeedsReauthError', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'revoked',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => {
      throw Object.assign(new Error('invalid_grant: refresh token revoked'), { errorCode: 'invalid_grant' })
    }

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)).rejects.toBeInstanceOf(
      McpOAuthNeedsReauthError,
    )

    // The stale credentials are left intact (no partial write).
    const stored = await getMcpServerCredentials(getDb(), serverId)
    if (stored?.type !== 'oauth') {
      throw new Error('expected oauth credentials')
    }
    expect(stored.access_token).toBe('stale')
  })

  it('rethrows non-invalid_grant refresh failures unchanged', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      refresh_token: 'r1',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => {
      throw new Error('network down')
    }

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)).rejects.toThrow('network down')
  })

  it('throws needs-reauth when a stale token lacks the fields required to refresh', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale',
      expires_at: Date.now() - 1_000,
      // no refresh_token / issuer / tokenEndpoint / clientId
    })

    const refresh: RefreshFn = async () => {
      throw new Error('should not refresh')
    }

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch, refresh)).rejects.toBeInstanceOf(
      McpOAuthNeedsReauthError,
    )
  })

  it('throws when the server has no oauth credentials at all', async () => {
    await expect(ensureValidMcpOAuthToken(getDb(), serverId, neverCalledFetch)).rejects.toThrow(/no OAuth credentials/)
  })
})
