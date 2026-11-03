/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, mock } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createModel, getModel } from '@/dal/models'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getDb } from '@/db/database'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { createTinfoilSession } from './tinfoil-session'
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
    await session.disconnect()
    expect(await getModel(getDb(), 'oauth-model')).toMatchObject({
      enabled: 0,
      oauthProvider: 'tinfoil',
      apiKey: null,
      deletedAt: null,
    })
    expect(await getModel(getDb(), 'byok-model')).toMatchObject({ enabled: 1, apiKey: 'own-key' })
    expect(auth.revoke).toHaveBeenCalledWith('rotated-refresh')
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toMatchObject({
      enabled: false,
      credentials: { access_token: '' },
    })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })
  it('keeps credentials for retry when revocation fails', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    const { auth, session } = harness()
    auth.revoke.mockRejectedValue(new TinfoilConnectionError('unavailable'))
    await expect(session.disconnect()).rejects.toThrow('unavailable')
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials).toEqual(renewed)
  })
  it('refuses disabled and disconnected sessions even with a fresh token', async () => {
    const { auth, session } = harness()
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, false)
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
  })
  it('disables credentials and OAuth models together, then re-enables without losing keys or BYOK access', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', renewed, true)
    await createModel(getDb(), {
      id: 'oauth',
      provider: 'tinfoil',
      name: 'OAuth',
      model: 'model',
      oauthProvider: 'tinfoil',
    })
    await createModel(getDb(), { id: 'byok', provider: 'tinfoil', name: 'BYOK', model: 'model', apiKey: 'own-key' })
    const { auth, session } = harness()
    await session.setEnabled(false)
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({ credentials: renewed, enabled: false })
    expect(await getModel(getDb(), 'oauth')).toMatchObject({ enabled: 0, oauthProvider: 'tinfoil' })
    expect(await getModel(getDb(), 'byok')).toMatchObject({ enabled: 1, apiKey: 'own-key' })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    expect(auth.refresh).not.toHaveBeenCalled()
    expect(auth.revoke).not.toHaveBeenCalled()
    await session.setEnabled(true)
    expect(await session.getAccessToken()).toBe(renewed.access_token)
    expect(await getModel(getDb(), 'oauth')).toMatchObject({ enabled: 1 })
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
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual({ credentials: renewed, enabled: false })
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })

  it('cannot re-enable disconnected or rejected credentials', async () => {
    const { session } = harness()
    await expect(session.setEnabled(true)).rejects.toBeInstanceOf(TinfoilReauthorizationError)
    await saveIntegrationCredentials(getDb(), 'tinfoil', { ...renewed, reauth_required: true }, false)
    await expect(session.setEnabled(true)).rejects.toBeInstanceOf(TinfoilReauthorizationError)
  })
})
