/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, mock, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createModel, getModel } from '@/dal/models'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getDb } from '@/db/database'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { createTinfoilSession } from './tinfoil-session'
import { getProviderConnectionAttempt, saveProviderAuthorization } from './provider-connection-attempt'
import { invalidateProviderConnectionAttempts } from './provider-connection-attempt'
import { saveProviderConnectionInTransaction } from '@/dal/provider-connections'
import { credentialBinding, writeProviderCredentials } from '@/providers/credentials'
import { providerConnectionsTable, providerConnectionSecretsTable, integrationsSecretsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { tinfoilAuth, TinfoilReauthorizationError, TinfoilConnectionError } from './tinfoil-auth'
import { invalidateIdentityLifetime } from './identity-lifetime'
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy'

/** Deterministic stand-in for the browser's origin-wide Web Lock. */
const serialLock = () => {
  let tail = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work)
    tail = next.then(
      () => {},
      () => {},
    )
    return next
  }
}
const expired = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 1 }
const renewed = { access_token: 'new-access', refresh_token: 'rotated-refresh', expires_at: 999_999 }
const harness = () => {
  const auth = {
    ...tinfoilAuth,
    refresh: mock(async (_refresh: string) => renewed),
    revoke: mock(async (_token: string) => {}),
  }
  return { auth, session: createTinfoilSession({ db: getDb, auth, lock: serialLock(), now: () => 100_000 }) }
}

const saveCanonicalSession = (credentials = expired) =>
  getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'oauth',
      credentials,
    }),
  )
const canonicalSecret = () =>
  getDb()
    .select()
    .from(providerConnectionSecretsTable)
    .where(eq(providerConnectionSecretsTable.id, 'oauth:tinfoil'))
    .get()

describe('Tinfoil session lifecycle', () => {
  beforeAll(setupTestDatabase)
  beforeEach(() => rejectNestedTransactions(getDb()))
  afterEach(async () => {
    mock.restore()
    await resetTestDatabase()
  })
  afterAll(teardownTestDatabase)

  it.each(['legacy', 'canonical'] as const)(
    'does not discard a saved %s grant after concurrent refresh and toggle',
    async (kind) => {
      const original = { ...expired, authorizationId: 'retained-grant' }
      if (kind === 'legacy') {
        await saveIntegrationCredentials(getDb(), 'tinfoil', original, true)
      } else {
        await saveCanonicalSession(original)
      }
      const { auth, session } = harness()
      const started = Promise.withResolvers<void>()
      const refreshed = Promise.withResolvers<typeof renewed>()
      auth.refresh.mockImplementation(() => {
        started.resolve()
        return refreshed.promise
      })
      const refreshing = session.getAccessToken()
      await started.promise
      const disabling = session.setEnabled(false)
      const discarding = session.discardAuthorization(original)
      refreshed.resolve(renewed)
      await Promise.all([refreshing, disabling, discarding])
      expect(auth.revoke).not.toHaveBeenCalled()
      expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toMatchObject({
        credentials: { ...renewed, authorizationId: 'retained-grant' },
        enabled: false,
      })
    },
  )

  it('retains ownership of a local grant after its metadata is tombstoned', async () => {
    await saveCanonicalSession()
    await getDb()
      .update(providerConnectionsTable)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
    const { auth, session } = harness()
    await session.discardAuthorization(expired)
    expect(auth.revoke).not.toHaveBeenCalled()
    await session.disconnect()
    expect(auth.revoke).toHaveBeenCalledWith('old-refresh')
  })

  it('revokes a retained local grant when sync has removed its metadata row', async () => {
    await saveCanonicalSession()
    // Simulate the sync engine removing metadata while device-only secrets remain.
    await getDb().delete(providerConnectionsTable).where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
    const { auth, session } = harness()
    await session.disconnect()
    expect(auth.revoke).toHaveBeenCalledWith('old-refresh')
    expect(JSON.parse((await canonicalSecret())!.credentials!)).not.toHaveProperty('access_token')
  })

  it('never revokes a manual credential stored with an unrelated local binding', async () => {
    await saveCanonicalSession()
    await getDb()
      .update(providerConnectionSecretsTable)
      .set({ binding: credentialBinding({ provider: 'tinfoil', authMethod: 'api_key', url: null }) })
      .where(eq(providerConnectionSecretsTable.id, 'oauth:tinfoil'))
    const { auth, session } = harness()
    await session.disconnect()
    expect(auth.revoke).not.toHaveBeenCalled()
  })

  it('revokes only an unused grant while retaining the saved account', async () => {
    await saveCanonicalSession()
    const { auth, session } = harness()
    await session.discardAuthorization(renewed)
    expect(auth.revoke).toHaveBeenCalledWith('rotated-refresh')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.access_token).toBe('old-access')
  })

  it('reuses a fresh session without making a token request', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    const { auth, session } = harness()
    expect(await session.getAccessToken()).toBe('new-access')
    expect(auth.refresh).not.toHaveBeenCalled()
  })
  it('does not save a late refresh after identity teardown when local data is retained', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const before = await getIntegrationCredentials(getDb(), 'tinfoil')
    const { auth, session } = harness()
    auth.refresh.mockImplementation(async () => {
      invalidateIdentityLifetime()
      return renewed
    })
    await expect(session.getAccessToken()).rejects.toHaveProperty('name', 'AbortError')
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual(before)
  })
  it.each(['legacy', 'canonical'] as const)('rolls back a %s refresh interrupted after the SQL write', async (kind) => {
    if (kind === 'legacy') {
      await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    } else {
      await saveCanonicalSession()
    }
    const before = await getIntegrationCredentials(getDb(), 'tinfoil')
    const { session: provider } = harness()
    const session = (getDb() as unknown as { session: { client: RemoteCallback } }).session
    const execute = session.client
    const table = kind === 'legacy' ? 'integrations_secrets' : 'provider_connection_secrets'
    const write = spyOn(session, 'client').mockImplementation(async (sql, params, method) => {
      const result = await execute(sql, params, method)
      if (sql.startsWith(`update "${table}"`)) {
        invalidateIdentityLifetime()
      }
      return result
    })
    try {
      await expect(provider.getAccessToken()).rejects.toHaveProperty('name', 'AbortError')
      expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual(before)
    } finally {
      write.mockRestore()
    }
  })
  it('serializes concurrent refreshes and persists the rotated token before other readers proceed', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    expect(await Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken()])).toEqual([
      'new-access',
      'new-access',
      'new-access',
    ])
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    expect(auth.refresh).toHaveBeenCalledWith('old-refresh')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.refresh_token).toBe('rotated-refresh')
  })
  it('marks an expired access-only grant for reconnect instead of advertising unusable access', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'expired', expires_at: 1 }, true)
    const { auth, session } = harness()
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.reauth_required).toBe(true)
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
  })

  it('continues using an access-only grant while it is still fresh', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'fresh', expires_at: 999_999 }, true)
    const { auth, session } = harness()
    expect(await session.getAccessToken()).toBe('fresh')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.reauth_required).toBeUndefined()
    expect(auth.refresh).not.toHaveBeenCalled()
  })

  it('marks rejected grants for reconnect and never replays them', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    auth.refresh.mockRejectedValue(new TinfoilReauthorizationError())
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.reauth_required).toBe(true)
  })
  it('preserves the session on transient failures', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    auth.refresh.mockRejectedValue(new TinfoilConnectionError('unavailable'))
    await expect(session.getAccessToken()).rejects.toThrow('unavailable')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials).toEqual(expired)
  })
  it('revokes the current refresh token before clearing local access', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    await session.getAccessToken()
    await createModel(getDb(), {
      id: 'oauth-model',
      name: 'OAuth',
      provider: 'tinfoil',
      model: 'deepseek',
      oauthProvider: 'tinfoil',
    })
    await createModel(getDb(), {
      id: 'byok-model',
      name: 'BYOK',
      provider: 'tinfoil',
      model: 'deepseek',
      apiKey: 'own-key',
    })
    await createModel(getDb(), {
      id: 'connection-byok',
      provider: 'tinfoil',
      name: 'Connection BYOK',
      model: 'model',
      apiKey: 'connection-key',
      providerDefault: 1,
    })
    await session.disconnect()
    expect(await getModel(getDb(), 'connection-byok')).toMatchObject({ apiKey: null, enabled: 1 })
    expect(await getModel(getDb(), 'oauth-model')).toMatchObject({
      enabled: 1,
      oauthProvider: 'tinfoil',
      apiKey: null,
      deletedAt: null,
    })
    expect(await getModel(getDb(), 'byok-model')).toMatchObject({ enabled: 1, apiKey: 'own-key' })
    expect(auth.revoke).toHaveBeenCalledWith('rotated-refresh')
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toMatchObject({
      enabled: false,
      credentials: { access_token: '', sessionRevision: expect.any(String) },
    })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })
  it('waits for an in-flight refresh and revokes its rotated credential before disconnecting', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    const refreshStarted = Promise.withResolvers<void>()
    const refreshed = Promise.withResolvers<typeof renewed>()
    auth.refresh.mockImplementation(() => {
      refreshStarted.resolve()
      return refreshed.promise
    })
    const token = session.getAccessToken()
    await refreshStarted.promise
    const disconnect = session.disconnect()
    expect(auth.revoke).not.toHaveBeenCalled()

    refreshed.resolve(renewed)
    expect(await token).toBe(renewed.access_token)
    await disconnect
    expect(auth.revoke).toHaveBeenCalledWith(renewed.refresh_token)
    expect(auth.revoke).toHaveBeenCalledTimes(1)
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({
      enabled: false,
      credentials: { access_token: '', sessionRevision: expect.any(String) },
    })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })

  it('does not give queued requests a credential while disconnect is revoking it', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    const { auth, session } = harness()
    const revokeStarted = Promise.withResolvers<void>()
    const revoked = Promise.withResolvers<void>()
    auth.revoke.mockImplementation(() => {
      revokeStarted.resolve()
      return revoked.promise
    })
    const disconnect = session.disconnect()
    await revokeStarted.promise
    const queuedRequest = session.getAccessToken()
    void queuedRequest.catch(() => {})
    revoked.resolve()
    await disconnect
    await expect(queuedRequest).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
  })

  it('keeps credentials for retry when revocation fails', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    const { auth, session } = harness()
    auth.revoke.mockRejectedValue(new TinfoilConnectionError('unavailable'))
    await expect(session.disconnect()).rejects.toThrow('unavailable')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials).toEqual(renewed)
  })
  it('rolls back both owned BYOK and OAuth state if the disconnect transaction fails', async () => {
    const db = getDb()
    await saveIntegrationCredentials(db, 'tinfoil', renewed, true)
    await createModel(db, {
      id: 'connection-byok',
      provider: 'tinfoil',
      name: 'Connection BYOK',
      model: 'model',
      apiKey: 'connection-key',
      providerDefault: 1,
    })
    mock.restore()
    const transaction = db.transaction.bind(db)
    const failing = spyOn(db, 'transaction').mockImplementation((work) =>
      transaction(async (tx) => {
        await work(tx)
        throw new Error('Transaction failed')
      }),
    )
    try {
      await expect(harness().session.disconnect()).rejects.toThrow('Transaction failed')
    } finally {
      failing.mockRestore()
    }
    expect(await getModel(db, 'connection-byok')).toMatchObject({ apiKey: 'connection-key' })
    expect(await getIntegrationCredentials(db, 'tinfoil')).toMatchObject({ enabled: true, credentials: renewed })
  })

  it('refuses disabled and disconnected sessions even with a fresh token', async () => {
    const { auth, session } = harness()
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, false)
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
  })
  it('disables access without overwriting individual model choices or BYOK access', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    await createModel(getDb(), {
      id: 'oauth',
      provider: 'tinfoil',
      name: 'OAuth',
      model: 'model',
      oauthProvider: 'tinfoil',
    })
    await createModel(getDb(), { id: 'byok', provider: 'tinfoil', name: 'BYOK', model: 'model', apiKey: 'own-key' })
    await createModel(getDb(), {
      id: 'disabled-oauth',
      provider: 'tinfoil',
      name: 'Disabled',
      model: 'model2',
      oauthProvider: 'tinfoil',
      enabled: 0,
    })
    const { auth, session } = harness()
    await session.setEnabled(false)
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({
      credentials: { ...renewed, sessionRevision: expect.any(String) },
      enabled: false,
    })
    expect(await getModel(getDb(), 'oauth')).toMatchObject({ enabled: 1, oauthProvider: 'tinfoil' })
    expect(await getModel(getDb(), 'byok')).toMatchObject({ enabled: 1, apiKey: 'own-key' })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
    expect(auth.revoke).not.toHaveBeenCalled()
    await session.setEnabled(true)
    expect(await session.getAccessToken()).toBe(renewed.access_token)
    expect(await getModel(getDb(), 'oauth')).toMatchObject({ enabled: 1 })
    expect(await getModel(getDb(), 'disabled-oauth')).toMatchObject({ enabled: 0 })
  })

  it('serializes disable behind an in-flight refresh so the new tokens remain disabled', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', expired, true)
    const { auth, session } = harness()
    const pending = Promise.withResolvers<typeof renewed>()
    auth.refresh.mockImplementation(() => pending.promise)
    const token = session.getAccessToken()
    const disabled = session.setEnabled(false)
    pending.resolve(renewed)
    await token
    await disabled
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({
      credentials: { ...renewed, sessionRevision: expect.any(String) },
      enabled: false,
    })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })

  it('keeps the session generation through refresh but rotates it on explicit state changes', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { ...expired, sessionRevision: 'original' }, true)
    const { session } = harness()
    const original = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    await session.getAccessToken()
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).toEqual(original)
    await session.setEnabled(true)
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).toEqual(original)
    await session.setEnabled(false)
    const disabled = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    expect(disabled).not.toEqual(original)
    await session.setEnabled(true)
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).not.toEqual(disabled)
    await session.disconnect()
    const disconnected = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    await session.disconnect()
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).not.toEqual(disconnected)
  })

  it('does not adopt a pending grant after a disconnect/reconnect/disconnect cycle', async () => {
    const { session } = harness()
    await session.disconnect()
    const attempt = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    await saveProviderAuthorization(getDb(), { tinfoilCredentials: renewed, attempt })
    await session.disconnect()
    await expect(saveProviderAuthorization(getDb(), { tinfoilCredentials: renewed, attempt })).rejects.toThrow(
      'connection changed',
    )
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })

  it('cannot re-enable disconnected or rejected credentials', async () => {
    const { session } = harness()
    await expect(session.setEnabled(true)).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    await saveIntegrationCredentials(getDb(), 'tinfoil', { ...renewed, reauth_required: true }, false)
    await expect(session.setEnabled(true)).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })

  it('rotates canonical credentials without changing the binding or authorization generation', async () => {
    await saveCanonicalSession()
    const before = await getIntegrationCredentials(getDb(), 'tinfoil')
    const attempt = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    const { session } = harness()
    expect(await session.getAccessToken()).toBe(renewed.access_token)
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({
      enabled: true,
      credentials: { ...renewed, sessionRevision: before?.credentials.sessionRevision },
    })
    expect((await canonicalSecret())?.binding).toBe(
      credentialBinding({ provider: 'tinfoil', authMethod: 'oauth', url: null }),
    )
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).toEqual(attempt)
  })

  for (const outcome of ['success', 'rejection'] as const) {
    it.each(['disabled', 'deleted', 'redirected', 'invalidated', 'reconnected', 'disconnected'] as const)(
      `does not overwrite a %s canonical session after a late refresh ${outcome}`,
      async (change) => {
        await saveCanonicalSession()
        const { session, auth } = harness()
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<typeof renewed>()
        auth.refresh.mockImplementation(() => {
          started.resolve()
          return pending.promise
        })
        const token = session.getAccessToken()
        await started.promise
        const db = getDb()
        switch (change) {
          case 'disabled':
            await db
              .update(providerConnectionsTable)
              .set({ enabled: 0 })
              .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
            break
          case 'deleted':
            await db
              .update(providerConnectionsTable)
              .set({ deletedAt: new Date().toISOString() })
              .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
            break
          case 'redirected':
            await db
              .update(providerConnectionsTable)
              .set({ url: 'https://changed.example/v1' })
              .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
            break
          case 'invalidated':
            await invalidateProviderConnectionAttempts(db, 'tinfoil')
            break
          case 'reconnected':
            await saveCanonicalSession({
              access_token: 'another-account',
              refresh_token: 'another-refresh',
              expires_at: 999_999,
            })
            break
          case 'disconnected':
            await writeProviderCredentials(db, 'oauth:tinfoil', { sessionRevision: 'tombstone' }, null)
            break
        }
        const changedSecret = await canonicalSecret()
        const changedSession = await getIntegrationCredentials(db, 'tinfoil')
        if (outcome === 'success') {
          pending.resolve(renewed)
        } else {
          pending.reject(new TinfoilReauthorizationError())
        }
        await expect(token).rejects.toThrow('connection changed')
        expect(await canonicalSecret()).toEqual(changedSecret)
        expect(await getIntegrationCredentials(db, 'tinfoil')).toEqual(changedSession)
        expect(await db.select().from(integrationsSecretsTable)).toEqual([])
      },
    )
  }

  it('rejects a stale canonical credential write without creating a legacy fallback', async () => {
    await saveCanonicalSession()
    const old = await getIntegrationCredentials(getDb(), 'tinfoil')
    await saveCanonicalSession({
      access_token: 'another-account',
      refresh_token: 'another-refresh',
      expires_at: 999_999,
    })
    const changed = await canonicalSecret()
    await expect(
      saveIntegrationCredentials(
        getDb(),
        'tinfoil',
        { ...renewed, sessionRevision: old?.credentials.sessionRevision },
        true,
        true,
      ),
    ).rejects.toThrow('connection changed')
    expect(await canonicalSecret()).toEqual(changed)
    expect(await getDb().select().from(integrationsSecretsTable)).toEqual([])
  })
})
