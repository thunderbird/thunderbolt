/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { providerConnectionsTable as connections, providerConnectionSecretsTable as secrets } from '@/db/tables'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  deleteProviderConnection,
  disconnectProviderConnection,
  getProviderConnection,
  getProviderCredentials,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import * as otariAuth from '@/lib/otari-auth'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { discardOtariAuthorization } from './otari-session'
import { credentialBinding, writeProviderCredentials } from './credentials'
import * as oauthSession from './oauth-session'

const id = 'oauth:otari'
const origin = 'https://work.example'
const save = (token = 'old-token', extra = {}) =>
  saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Work',
    authMethod: 'oauth',
    url: `${origin}/api/v1`,
    credentials: { access_token: token },
    ...extra,
  })
const readStored = async () => {
  const row = await getDb().select().from(secrets).where(eq(secrets.id, id)).get()
  return JSON.parse(row?.credentials ?? '{}') as { access_token?: string; reauth_required?: boolean }
}
beforeEach(async () => {
  await resetTestDatabase()
  spyOn(otariAuth, 'revokeOtariToken').mockResolvedValue()
})
afterEach(() => mock.restore())
afterAll(teardownTestDatabase)

describe('Otari delegated-key lifecycle', () => {
  it.each(['disconnect', 'remove', 'replace', 'disabled'] as const)('revokes the old key on %s', async (action) => {
    await save()
    const revoke = spyOn(otariAuth, 'revokeOtariToken')
    if (action === 'disabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
    }
    if (action === 'remove') {
      await deleteProviderConnection(getDb(), id)
      expect(await getProviderConnection(getDb(), id)).toBeNull()
    } else if (action === 'replace') {
      await save('new-token', { url: 'https://other.example/api/v1' })
      expect((await getProviderCredentials(getDb(), id))?.access_token).toBe('new-token')
    } else {
      await disconnectProviderConnection(getDb(), id)
      expect(await readStored()).not.toHaveProperty('access_token')
    }
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith(origin, 'old-token')
  })

  it.each(['disconnect', 'remove', 'replace'] as const)(
    'keeps the current grant retryable if %s fails to revoke',
    async (action) => {
      await save()
      spyOn(otariAuth, 'revokeOtariToken').mockRejectedValue(new Error('Unavailable'))
      const operation =
        action === 'remove'
          ? deleteProviderConnection(getDb(), id)
          : action === 'replace'
            ? save('new-token')
            : disconnectProviderConnection(getDb(), id)
      await expect(operation).rejects.toThrow('Unavailable')
      expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: true })
      expect((await getProviderCredentials(getDb(), id))?.access_token).toBe('old-token')
    },
  )

  it('uses the locally approved origin after synced metadata changes its URL', async () => {
    await save()
    await getDb().update(connections).set({ url: 'https://unapproved.example/api/v1' }).where(eq(connections.id, id))
    await disconnectProviderConnection(getDb(), id)
    expect(otariAuth.revokeOtariToken).toHaveBeenCalledWith(origin, 'old-token')
  })

  it('does not revoke a manually configured API key or an unchanged OAuth grant', async () => {
    const manual = await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Manual',
      authMethod: 'api_key',
      url: `${origin}/api/v1`,
      credentials: { apiKey: 'manual-key' },
    })
    await disconnectProviderConnection(getDb(), manual)
    await save()
    await save('old-token', { name: 'Renamed' })
    expect(otariAuth.revokeOtariToken).not.toHaveBeenCalled()
  })

  it('does not revoke the old grant before validating a stale replacement', async () => {
    const attempt = await getProviderConnectionAttempt(getDb(), 'otari')
    await save()
    await expect(save('new-token', { attempt })).rejects.toThrow('changed')
    expect(otariAuth.revokeOtariToken).not.toHaveBeenCalled()
    expect((await getProviderCredentials(getDb(), id))?.access_token).toBe('old-token')
  })

  it('retires an irreversibly revoked grant even if its replacement is cancelled', async () => {
    await save()
    const controller = new AbortController()
    spyOn(otariAuth, 'revokeOtariToken').mockImplementation(async () => controller.abort())
    await expect(save('new-token', { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
    expect(await readStored()).toMatchObject({ access_token: 'old-token', reauth_required: true })
  })

  it('does not erase a different session that appeared while revocation was in flight', async () => {
    await save()
    spyOn(otariAuth, 'revokeOtariToken').mockImplementation(async () => {
      await writeProviderCredentials(
        getDb(),
        id,
        { access_token: 'other-token', sessionRevision: 'other-session' },
        credentialBinding({ provider: 'otari', authMethod: 'oauth', url: `${origin}/api/v1` }),
      )
    })
    await expect(disconnectProviderConnection(getDb(), id)).rejects.toThrow('changed')
    expect((await getProviderCredentials(getDb(), id))?.access_token).toBe('other-token')
  })

  it.each(['disconnect', 'remove'] as const)(
    'serializes %s with a pending replacement and revokes the new key too',
    async (action) => {
      const queue = { tail: Promise.resolve() }
      spyOn(oauthSession, 'withProviderOAuthLock').mockImplementation(async (_id, work) => {
        const previous = queue.tail
        const released = Promise.withResolvers<void>()
        queue.tail = released.promise
        await previous
        try {
          return await work()
        } finally {
          released.resolve()
        }
      })
      await save()
      const started = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const revoke = spyOn(otariAuth, 'revokeOtariToken').mockImplementation(async (_origin, token) => {
        if (token === 'old-token') {
          started.resolve()
          await released.promise
        }
      })
      const replacing = save('new-token')
      await started.promise
      const removing =
        action === 'remove' ? deleteProviderConnection(getDb(), id) : disconnectProviderConnection(getDb(), id)
      released.resolve()
      await Promise.all([replacing, removing])
      expect(revoke.mock.calls).toEqual([
        [origin, 'old-token'],
        [origin, 'new-token'],
      ])
      expect(await readStored()).not.toHaveProperty('access_token')
      if (action === 'remove') {
        expect(await getProviderConnection(getDb(), id)).toBeNull()
      } else {
        expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
      }
    },
  )

  it('clears a revoked grant despite a simultaneous enable-state change', async () => {
    await save()
    spyOn(otariAuth, 'revokeOtariToken').mockImplementation(async () => {
      await updateProviderConnection(getDb(), id, { enabled: false })
    })
    await disconnectProviderConnection(getDb(), id)
    expect(await readStored()).not.toHaveProperty('access_token')
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0, connected: false })
  })

  it('discards only the unused grant and retains a successfully saved token after later UI failures', async () => {
    await save()
    await discardOtariAuthorization(getDb(), origin, 'old-token')
    expect(otariAuth.revokeOtariToken).not.toHaveBeenCalled()
    await discardOtariAuthorization(getDb(), 'https://other.example', 'unused-token')
    expect(otariAuth.revokeOtariToken).toHaveBeenCalledWith('https://other.example', 'unused-token')
    expect((await getProviderCredentials(getDb(), id))?.access_token).toBe('old-token')
  })
})
