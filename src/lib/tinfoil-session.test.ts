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
import { tinfoilAuth, TinfoilReauthorizationError, TinfoilConnectionError } from './tinfoil-auth'

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

describe('Tinfoil session lifecycle', () => {
  beforeAll(setupTestDatabase)
  beforeEach(() => rejectNestedTransactions(getDb()))
  afterEach(async () => {
    mock.restore()
    await resetTestDatabase()
  })
  afterAll(teardownTestDatabase)

  it('reuses a fresh session without making a token request', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    const { auth, session } = harness()
    expect(await session.getAccessToken()).toBe('new-access')
    expect(auth.refresh).not.toHaveBeenCalled()
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
    await session.getAccessToken()
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).toEqual({
      provider: 'tinfoil',
      revision: 'original',
    })
    await session.setEnabled(true)
    expect(await getProviderConnectionAttempt(getDb(), 'tinfoil')).toEqual({
      provider: 'tinfoil',
      revision: 'original',
    })
    await session.setEnabled(false)
    const disabled = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    expect(disabled).not.toEqual({ provider: 'tinfoil', revision: 'original' })
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
})
