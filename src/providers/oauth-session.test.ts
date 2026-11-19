/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import { eq } from 'drizzle-orm'
import { providerConnectionSecretsTable } from '@/db/tables'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  getProviderCredentials,
  getProviderConnection,
  saveProviderConnection,
  disconnectProviderConnection,
  updateProviderConnection,
  resolveProviderConnection,
} from '@/dal/provider-connections'
import { http, HttpError, type ResponsePromise } from '@/lib/http'
import { stubJsonResponse } from '@/test-utils/http'
import { resolveOAuthAccessToken } from './oauth-session'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy'

const originalLocks = navigator.locks
beforeAll(() => {
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: <T>(_name: string, work: () => Promise<T>) => {
        const next = tail.then(work)
        tail = next.then(
          () => {},
          () => {},
        )
        return next
      },
    },
  })
})
afterAll(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks }))
beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => {
  post.mockRestore()
})
let post: ReturnType<typeof spyOn<typeof http, 'post'>>
beforeEach(() => {
  post = spyOn(http, 'post')
})
const connect = (expires_at = 1) =>
  saveProviderConnection(getDb(), {
    provider: 'exa',
    name: 'Exa',
    authMethod: 'oauth',
    credentials: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at,
      oauth: {
        clientId: 'client',
        issuer: 'https://issuer.example',
        tokenEndpoint: 'https://issuer.example/token',
        resource: 'https://mcp.exa.ai/mcp/oauth',
      },
    },
  })

test('refreshes once for concurrent requests and retains the connection revision', async () => {
  const id = await connect()
  const revision = (await getProviderCredentials(getDb(), id))?.sessionRevision
  post.mockReturnValue(
    stubJsonResponse({ access_token: 'new-access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 }),
  )
  expect(await Promise.all([resolveOAuthAccessToken(getDb(), id), resolveOAuthAccessToken(getDb(), id)])).toEqual([
    'new-access',
    'new-access',
  ])
  expect(post).toHaveBeenCalledTimes(1)
  expect(await getProviderCredentials(getDb(), id)).toMatchObject({
    access_token: 'new-access',
    refresh_token: 'rotated',
    sessionRevision: revision,
  })
})

test('uses a fresh token without an HTTP request', async () => {
  const id = await connect(Date.now() + 3_600_000)
  expect(await resolveOAuthAccessToken(getDb(), id)).toBe('old-access')
  expect(post).not.toHaveBeenCalled()
})

test('retains a retryable session after network interruption and releases the refresh lock', async () => {
  const id = await connect()
  const before = await getProviderCredentials(getDb(), id)
  post.mockImplementationOnce(() => stubJsonResponse(Promise.reject(new TypeError('Failed to fetch'))))
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('Failed to fetch')
  expect(await getProviderCredentials(getDb(), id)).toEqual(before)
  post.mockReturnValue(stubJsonResponse({ access_token: 'recovered', token_type: 'Bearer', expires_in: 3600 }))
  expect(await resolveOAuthAccessToken(getDb(), id)).toBe('recovered')
  expect(post).toHaveBeenCalledTimes(2)
})

test('rejects a late refresh after identity teardown even when local credentials are retained', async () => {
  const id = await connect()
  const before = await getProviderCredentials(getDb(), id)
  post.mockImplementation(() => {
    invalidateIdentityLifetime()
    return stubJsonResponse({ access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer' })
  })
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toHaveProperty('name', 'AbortError')
  expect(await getProviderCredentials(getDb(), id)).toEqual(before)
})

test('rolls back refreshed credentials when identity teardown interrupts the SQL update', async () => {
  const id = await connect()
  const before = await getProviderCredentials(getDb(), id)
  post.mockReturnValue(
    stubJsonResponse({ access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer' }),
  )
  const session = (getDb() as unknown as { session: { client: RemoteCallback } }).session
  const execute = session.client
  const write = spyOn(session, 'client').mockImplementation(async (sql, params, method) => {
    const result = await execute(sql, params, method)
    if (sql.startsWith('update "provider_connection_secrets"')) {
      invalidateIdentityLifetime()
    }
    return result
  })
  try {
    await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toHaveProperty('name', 'AbortError')
    expect(await getProviderCredentials(getDb(), id)).toEqual(before)
  } finally {
    write.mockRestore()
  }
})

test('does not start a refresh if identity teardown interrupts the outer connection read', async () => {
  const id = await connect()
  const session = (getDb() as unknown as { session: { client: RemoteCallback } }).session
  const execute = session.client
  const read = spyOn(session, 'client').mockImplementation(async (sql, params, method) => {
    const result = await execute(sql, params, method)
    if (sql.startsWith('select') && sql.includes('"provider_connections"')) {
      invalidateIdentityLifetime()
    }
    return result
  })
  try {
    await expect(resolveProviderConnection(getDb(), id)).rejects.toHaveProperty('name', 'AbortError')
    expect(post).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
  }
})

test('does not replace a reconnected session with an older refresh result', async () => {
  const id = await connect()
  const replacement = { access_token: 'replacement', refresh_token: 'replacement-refresh', expires_at: 1 }
  post.mockImplementation(() =>
    stubJsonResponse(
      (async () => {
        await disconnectProviderConnection(getDb(), id)
        await saveProviderConnection(getDb(), {
          id,
          provider: 'exa',
          name: 'Exa',
          authMethod: 'oauth',
          credentials: replacement,
        })
        return { access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer' }
      })(),
    ),
  )
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('changed during refresh')
  expect(await getProviderCredentials(getDb(), id)).toMatchObject(replacement)
})

test.each(['disable', 'disconnect'] as const)(
  'does not restore credentials after %s during refresh',
  async (change) => {
    const id = await connect()
    post.mockImplementation(() =>
      stubJsonResponse(
        (async () => {
          if (change === 'disable') {
            await updateProviderConnection(getDb(), id, { enabled: false })
          } else {
            await disconnectProviderConnection(getDb(), id)
          }
          return { access_token: 'late', token_type: 'Bearer', expires_in: 3600 }
        })(),
      ),
    )
    await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('changed during refresh')
    expect((await getProviderCredentials(getDb(), id))?.access_token).not.toBe('late')
  },
)

test.each([
  'invalid_grant',
  'invalid_client',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])('marks terminal refresh error %s as needing reauthorization', async (code) => {
  const id = await connect()
  post.mockImplementation(() => {
    const result = Promise.resolve(new Response()) as ResponsePromise
    result.json = async () => {
      throw new HttpError(Response.json({ error: code }, { status: 400 }))
    }
    return result
  })
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('400')
  expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('Reconnect')
})

test.each([
  { body: { error: 'temporarily_unavailable' }, status: 503 },
  { body: { error: 'rate_limit_exceeded' }, status: 429 },
  { body: { unexpected: true }, status: 400 },
])('preserves credentials for nonterminal refresh failures %j', async ({ body, status }) => {
  const id = await connect()
  const before = await getProviderCredentials(getDb(), id)
  post.mockImplementation(() => {
    const result = Promise.resolve(new Response()) as ResponsePromise
    result.json = async () => {
      throw new HttpError(Response.json(body, { status }))
    }
    return result
  })
  await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow(String(status))
  expect(await getProviderCredentials(getDb(), id)).toEqual(before)
})

test.each([undefined, 'openid chatgpt.tokens.use.direct', 'openid'])(
  'retains refreshed scopes and stops ChatGPT plan access if permission is removed: %s',
  async (scope) => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'ChatGPT',
      authMethod: 'oauth',
      credentials: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1,
        oauth: {
          clientId: 'client',
          issuer: 'https://auth.openai.com',
          tokenEndpoint: 'https://auth.openai.com/token',
          resource: 'https://api.openai.com/v1',
          scope: 'chatgpt.tokens.use.direct',
        },
      },
    })
    post.mockReturnValue(
      stubJsonResponse({
        access_token: 'new-access',
        refresh_token: 'rotated',
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
      }),
    )
    if (scope === 'openid') {
      await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('not authorized')
      expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
      await expect(resolveOAuthAccessToken(getDb(), id)).rejects.toThrow('Reconnect')
    } else {
      expect(await resolveOAuthAccessToken(getDb(), id)).toBe('new-access')
    }
    const stored = await getDb()
      .select()
      .from(providerConnectionSecretsTable)
      .where(eq(providerConnectionSecretsTable.id, id))
      .get()
    expect(JSON.parse(stored!.credentials!)).toMatchObject({
      refresh_token: 'rotated',
      oauth: { scope: scope ?? 'chatgpt.tokens.use.direct' },
    })
    expect(post).toHaveBeenCalledTimes(1)
  },
)
