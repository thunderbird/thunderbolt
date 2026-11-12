/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  ServerError,
  TemporarilyUnavailableError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { eq } from 'drizzle-orm'
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mcpServersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ensureValidMcpOAuthToken, McpOAuthNeedsReauthError } from './ensure-valid-token'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'

type RefreshFn = typeof refreshAuthorization

const serverId = 'server-1'
const serverUrl = 'https://mcp.example.com/sse'
const issuer = 'https://auth.example.com'
const tokenEndpoint = 'https://auth.example.com/token'
const originalLocks = navigator.locks

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

/** Seed a refreshable session so lifecycle regressions exercise real SQLite writes. */
const seedRefreshSession = async () => {
  await seedServer()
  const credentials = {
    type: 'oauth' as const,
    approvedUrl: serverUrl,
    access_token: 'stale',
    refresh_token: 'old-refresh',
    expires_at: 1,
    issuer,
    tokenEndpoint,
    clientId: 'old-client',
  }
  await setMcpServerCredentials(getDb(), serverId, credentials)
  return credentials
}

beforeAll(async () => {
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T>(_name: string, options: LockOptions, work: () => Promise<T>) => {
        const predecessor = tail
        const released = Promise.withResolvers<void>()
        tail = released.promise
        await predecessor
        try {
          options.signal?.throwIfAborted()
          return await work()
        } finally {
          released.resolve()
        }
      },
    },
  })
  await setupTestDatabase()
})

afterAll(async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
  await teardownTestDatabase()
})

describe('ensureValidMcpOAuthToken', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('returns the access token without refreshing when fresh', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
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

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
    expect(token).toBe('fresh-token')
    expect(called).toBe(false)
  })

  it('treats a token with no expiry as fresh (never force-refreshes)', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
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

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
    expect(token).toBe('no-expiry-token')
    expect(called).toBe(false)
  })

  it('refreshes a stale token, rotates the refresh token, and recomputes expiry', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
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
    const token = await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
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
      approvedUrl: serverUrl,
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

    const token = await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
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
      approvedUrl: serverUrl,
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
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
    ])

    expect(a).toBe('fresh')
    expect(b).toBe('fresh')
    expect(refreshCalls).toBe(1)
  })

  it('evicts a failed refresh so a later call retries instead of replaying it', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
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

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)).rejects.toThrow(
      'transient network failure',
    )
    // The failed promise was evicted, so this call performs a fresh refresh.
    const token = await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
    expect(token).toBe('recovered')
    expect(attempt).toBe(2)
  })

  it('preserves the existing refresh token when the AS omits a new one', async () => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
      access_token: 'stale',
      refresh_token: 'keep-refresh',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => ({ access_token: 'rotated', token_type: 'Bearer', expires_in: 1200 })

    await ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)

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
      approvedUrl: serverUrl,
      access_token: 'stale',
      refresh_token: 'revoked',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => {
      throw new InvalidGrantError('refresh token revoked')
    }

    await expect(
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReauthError)

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
      approvedUrl: serverUrl,
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

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)).rejects.toThrow(
      'network down',
    )
  })

  // Metabase answers a dead refresh token with invalid_request, where RFC 6749 says invalid_grant.
  it.each([
    ['invalid_request', new InvalidRequestError('The token request is invalid.')],
    ['invalid_client', new InvalidClientError('Unknown client')],
    ['unauthorized_client', new UnauthorizedClientError('Client may not refresh')],
  ])('maps a refresh rejected with %s to McpOAuthNeedsReauthError', async (_code, rejection) => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
      access_token: 'stale',
      refresh_token: 'rotated-away',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => {
      throw rejection
    }

    await expect(
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReauthError)
  })

  it.each([
    ['server_error', new ServerError('HTTP 502: Invalid OAuth error response')],
    ['temporarily_unavailable', new TemporarilyUnavailableError('Try later')],
  ])('rethrows a transient %s refresh failure instead of forcing re-authorization', async (_code, failure) => {
    await seedServer()
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
      access_token: 'stale',
      refresh_token: 'r1',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    const refresh: RefreshFn = async () => {
      throw failure
    }

    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)).rejects.toBe(
      failure,
    )
  })

  it('throws needs-reauth when a stale token lacks the fields required to refresh', async () => {
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      approvedUrl: serverUrl,
      access_token: 'stale',
      expires_at: Date.now() - 1_000,
      // no refresh_token / issuer / tokenEndpoint / clientId
    })

    const refresh: RefreshFn = async () => {
      throw new Error('should not refresh')
    }

    await expect(
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
    ).rejects.toBeInstanceOf(McpOAuthNeedsReauthError)
  })

  it('throws when the server has no oauth credentials at all', async () => {
    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch)).rejects.toThrow(
      /no OAuth credentials/,
    )
  })

  describe('destination', () => {
    const movedUrl = 'https://mcp-moved.example.com/sse'
    const staleCredential = (approvedUrl: string) => ({
      type: 'oauth' as const,
      approvedUrl,
      access_token: 'stale-token',
      refresh_token: 'refresh-a',
      expires_at: Date.now() - 1_000,
      issuer,
      tokenEndpoint,
      clientId: 'client-1',
    })

    it('never uses a credential saved for another URL', async () => {
      await setMcpServerCredentials(getDb(), serverId, staleCredential(serverUrl))
      const refresh: RefreshFn = async () => {
        throw new Error('should not refresh')
      }

      await expect(ensureValidMcpOAuthToken(getDb(), serverId, movedUrl, neverCalledFetch, refresh)).rejects.toThrow(
        /no OAuth credentials/,
      )
    })

    it('keeps a refresh for the old URL away from a re-authorization for the new one', async () => {
      await seedServer()
      await setMcpServerCredentials(getDb(), serverId, staleCredential(serverUrl))
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<OAuthTokens>()
      const refresh: RefreshFn = () => {
        started.resolve()
        return release.promise
      }

      const oldUrlToken = ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
      await started.promise
      // The user points the server elsewhere and authorizes again while the old refresh is in flight.
      await getDb().update(mcpServersTable).set({ url: movedUrl }).where(eq(mcpServersTable.id, serverId))
      await setMcpServerCredentials(getDb(), serverId, {
        type: 'oauth',
        approvedUrl: movedUrl,
        access_token: 'token-b',
        refresh_token: 'refresh-b',
        expires_at: Date.now() + 600_000,
      })

      release.resolve({ access_token: 'rotated-a', token_type: 'Bearer', refresh_token: 'refresh-a2' })
      await expect(oldUrlToken).rejects.toThrow('changed during token refresh')
      expect(await ensureValidMcpOAuthToken(getDb(), serverId, movedUrl, neverCalledFetch, refresh)).toBe('token-b')
      expect(await getMcpServerCredentials(getDb(), serverId)).toMatchObject({
        approvedUrl: movedUrl,
        access_token: 'token-b',
        refresh_token: 'refresh-b',
      })
    })
  })

  it('rejects a retained-data refresh after identity teardown without changing its credential', async () => {
    const before = await seedRefreshSession()
    const refresh: RefreshFn = async () => {
      invalidateIdentityLifetime()
      return { access_token: 'retired-token', token_type: 'Bearer', refresh_token: 'retired-refresh' }
    }
    await expect(
      ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(await getMcpServerCredentials(getDb(), serverId)).toEqual(before)
  })

  it('preserves replacement credentials when an older refresh completes within the same identity', async () => {
    await seedRefreshSession()
    const replacement = { type: 'oauth' as const, access_token: 'replacement', clientId: 'new-client' }
    const refresh: RefreshFn = async () => {
      await setMcpServerCredentials(getDb(), serverId, replacement)
      return { access_token: 'old-client-token', token_type: 'Bearer' }
    }
    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)).rejects.toThrow(
      'changed during token refresh',
    )
    expect(await getMcpServerCredentials(getDb(), serverId)).toEqual(replacement)
  })

  it('rolls back a refresh when identity teardown interrupts its SQL update', async () => {
    const before = await seedRefreshSession()
    const session = (getDb() as unknown as { session: { client: RemoteCallback } }).session
    const execute = session.client
    const write = spyOn(session, 'client').mockImplementation(async (sql, params, method) => {
      const result = await execute(sql, params, method)
      if (sql.startsWith('update "mcp_secrets"')) {
        invalidateIdentityLifetime()
      }
      return result
    })
    try {
      await expect(
        ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, async () => ({
          access_token: 'late-token',
          token_type: 'Bearer',
        })),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(await getMcpServerCredentials(getDb(), serverId)).toEqual(before)
    } finally {
      write.mockRestore()
    }
  })

  it('keeps a new identity’s refresh independent and does not evict it when the retired refresh settles', async () => {
    const previous = await seedRefreshSession()
    const startedOld = Promise.withResolvers<void>()
    const oldTokens = Promise.withResolvers<OAuthTokens>()
    const old = ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, async () => {
      startedOld.resolve()
      return oldTokens.promise
    })
    await startedOld.promise
    invalidateIdentityLifetime()
    await setMcpServerCredentials(getDb(), serverId, {
      ...previous,
      clientId: 'new-client',
      refresh_token: 'new-refresh',
    })
    const startedNext = Promise.withResolvers<void>()
    const nextTokens = Promise.withResolvers<OAuthTokens>()
    const next = ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, async () => {
      startedNext.resolve()
      return nextTokens.promise
    })
    expect(next).not.toBe(old)
    oldTokens.resolve({ access_token: 'retired-token', token_type: 'Bearer' })
    await expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await startedNext.promise
    expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch)).toBe(next)
    nextTokens.resolve({ access_token: 'next-token', token_type: 'Bearer', expires_in: 3600 })
    expect(await next).toBe('next-token')
    expect(await getMcpServerCredentials(getDb(), serverId)).toMatchObject({
      access_token: 'next-token',
      clientId: 'new-client',
    })
  })

  it('serializes refreshes from independent callers and re-reads rotated credentials after acquiring the lock', async () => {
    await seedRefreshSession()
    const started = Promise.withResolvers<void>()
    const tokens = Promise.withResolvers<OAuthTokens>()
    const refresh = mock(async () => {
      started.resolve()
      return tokens.promise
    })
    const first = ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, neverCalledFetch, refresh)
    await started.promise
    // A distinct handle bypasses the per-window promise cache, like another window.
    const peer = new Proxy(getDb(), {})
    const second = ensureValidMcpOAuthToken(peer, serverId, serverUrl, neverCalledFetch, refresh)
    expect(second).not.toBe(first)
    tokens.resolve({
      access_token: 'rotated-once',
      token_type: 'Bearer',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    })
    expect(await first).toBe('rotated-once')
    expect(await second).toBe('rotated-once')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('passes the captured identity signal to refresh HTTP and rejects a response returned after cancellation', async () => {
    const before = await seedRefreshSession()
    const send: FetchLike = async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      invalidateIdentityLifetime()
      expect(init?.signal?.aborted).toBe(true)
      return Response.json({ access_token: 'retired-token', token_type: 'Bearer' })
    }
    const refresh: RefreshFn = async (_issuer, options) => {
      await options.fetchFn!('https://auth.example/token', { method: 'POST' })
      return { access_token: 'retired-token', token_type: 'Bearer' }
    }
    await expect(ensureValidMcpOAuthToken(getDb(), serverId, serverUrl, send, refresh)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(await getMcpServerCredentials(getDb(), serverId)).toEqual(before)
  })
})
