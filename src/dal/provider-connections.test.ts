/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, afterAll, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { providerConnectionsTable, providerConnectionSecretsTable, modelsSecretsTable, modelsTable } from '@/db/tables'
import { resetTestDatabase, teardownTestDatabase } from './test-utils'
import {
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  getProviderConnectionRevision,
  getProviderConnections,
  getProviderCredentials,
  updateProviderConnection,
  disconnectProviderConnection,
  deleteProviderConnection,
  resolveProviderConnection,
} from './provider-connections'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { addProviderModels } from '@/providers/models'
import { getModel, getAvailableModels } from './models'
import { isModelReady } from '@/settings/models/model-policy'
import { migrateProviderConnections } from '@/lib/data-migrations/provider-connections'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
const connect = (name = 'Work', authMethod: 'oauth' | 'api_key' = 'api_key') =>
  saveProviderConnection(getDb(), {
    provider: 'otari',
    name,
    authMethod,
    url: 'https://otari.example/api/v1',
    credentials: { apiKey: 'test-key' },
  })

describe('provider connections', () => {
  it('persists a connection without models and supports multiple API-key accounts', async () => {
    const a = await connect('Personal')
    const b = await connect('Work')
    expect(a).not.toBe(b)
    expect(await getProviderConnections(getDb())).toHaveLength(2)
    expect(await getDb().select().from(modelsTable)).toHaveLength(0)
    expect(await getProviderCredentials(getDb(), a)).toMatchObject({ apiKey: 'test-key' })
  })
  it('keeps exactly one OAuth identity across server changes and rejects stale authorization', async () => {
    const attempt = await getProviderConnectionAttempt(getDb(), 'otari')
    const id = await connect('Otari', 'oauth')
    expect(id).toBe('oauth:otari')
    await expect(
      saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Stale',
        authMethod: 'oauth',
        credentials: { access_token: 'stale' },
        attempt,
      }),
    ).rejects.toThrow('changed')
    await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Other',
      url: 'https://other.example/api/v1',
      authMethod: 'oauth',
      credentials: { access_token: 'new' },
    })
    expect(await getProviderConnections(getDb())).toHaveLength(1)
  })
  it('shares credentials across models without copying them and preserves model toggles', async () => {
    const id = await connect()
    const ids = await addProviderModels(getDb(), id, [{ id: 'one' }, { id: 'two' }, { id: 'one' }])
    expect(ids).toHaveLength(2)
    expect(await addProviderModels(getDb(), id, [{ id: 'one' }])).toEqual([ids[0]])
    expect(await getDb().select().from(modelsSecretsTable)).toHaveLength(0)
    expect((await getModel(getDb(), ids[0]))?.apiKey).toBe('test-key')
    await getDb().update(modelsTable).set({ enabled: 0 }).where(eq(modelsTable.id, ids[0]))
    await updateProviderConnection(getDb(), id, { enabled: false })
    expect(await getAvailableModels(getDb())).toHaveLength(0)
    await updateProviderConnection(getDb(), id, { enabled: true })
    expect((await getAvailableModels(getDb())).map((model) => model.id)).toEqual([ids[1]])
  })
  it('rejects credentials after a synced routing change, including keyless local servers', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'custom',
      name: 'Local',
      url: 'http://localhost:11434/v1',
      authMethod: 'api_key',
      credentials: {},
    })
    const [modelId] = await addProviderModels(getDb(), id, [{ id: 'qwen' }])
    expect(isModelReady((await getModel(getDb(), modelId))!)).toBe(true)
    await getDb()
      .update(providerConnectionsTable)
      .set({ url: 'https://other.example/v1' })
      .where(eq(providerConnectionsTable.id, id))
    expect(await getProviderCredentials(getDb(), id)).toBeNull()
    expect(isModelReady((await getModel(getDb(), modelId))!)).toBe(false)
    await expect(resolveProviderConnection(getDb(), id)).rejects.toThrow('Connect')
  })
  it('keeps metadata-only synced connections disconnected on this device', async () => {
    await getDb()
      .insert(providerConnectionsTable)
      .values({ id: 'remote', provider: 'openai', name: 'Other device', authMethod: 'api_key', enabled: 1 })
    expect((await getProviderConnections(getDb()))[0].connected).toBe(false)
    expect(await getProviderCredentials(getDb(), 'remote')).toBeNull()
  })
  it('disconnects locally, invalidates in-flight OAuth and soft-deletes metadata only on removal', async () => {
    const id = await connect('Otari', 'oauth')
    const [modelId] = await addProviderModels(getDb(), id, [{ id: 'one' }])
    const attempt = await getProviderConnectionAttempt(getDb(), 'otari')
    await disconnectProviderConnection(getDb(), id)
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({ enabled: 1, connected: false })
    expect((await getModel(getDb(), modelId))?.deletedAt).toBeNull()
    await expect(
      saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Stale',
        authMethod: 'oauth',
        credentials: { access_token: 'old' },
        attempt,
      }),
    ).rejects.toThrow('changed')
    await deleteProviderConnection(getDb(), id)
    expect(await getProviderConnections(getDb())).toHaveLength(0)
    expect((await getDb().select().from(providerConnectionsTable))[0].deletedAt).not.toBeNull()
  })
  it('rolls back cancelled saves and rejects invalid identity changes', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      saveProviderConnection(getDb(), {
        provider: 'openai',
        name: 'Cancelled',
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(await getProviderConnections(getDb())).toHaveLength(0)
    const id = await connect()
    await expect(
      saveProviderConnection(getDb(), {
        id,
        provider: 'openai',
        name: 'Changed',
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
      }),
    ).rejects.toThrow('cannot change')
  })
  it('moves legacy model keys into stable per-model connections without losing IDs or preferences', async () => {
    for (const id of ['old-a', 'old-b']) {
      await getDb()
        .insert(modelsTable)
        .values({
          id,
          provider: 'otari',
          model: id,
          name: id,
          url: 'https://otari.example/api/v1',
          enabled: id === 'old-a' ? 0 : 1,
        })
      await getDb().insert(modelsSecretsTable).values({ modelId: id, apiKey: 'legacy-key' })
    }
    await migrateProviderConnections(getDb())
    await migrateProviderConnections(getDb())
    expect(await getProviderConnections(getDb())).toHaveLength(2)
    expect(await getDb().select().from(providerConnectionSecretsTable)).toHaveLength(2)
    expect(await getModel(getDb(), 'old-a')).toMatchObject({
      enabled: 0,
      apiKey: 'legacy-key',
      providerConnectionId: 'legacy-model:old-a',
    })
    expect((await getModel(getDb(), 'old-b'))?.providerConnectionId).toBe('legacy-model:old-b')
    expect((await getDb().select().from(modelsSecretsTable)).every((row) => row.apiKey === null)).toBe(true)
  })
})

it('invalidates stale catalog and API-key verification even when the clock has not advanced', async () => {
  const id = await connect()
  const before = (await getProviderConnections(getDb()))[0]
  const revision = await getProviderConnectionRevision(getDb(), id)
  const clock = spyOn(Date, 'now').mockReturnValue(Date.parse(before.updatedAt))
  try {
    await updateProviderConnection(getDb(), id, { enabled: false })
    await updateProviderConnection(getDb(), id, { enabled: true })
    const after = (await getProviderConnections(getDb()))[0]
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
    expect(await getProviderConnectionRevision(getDb(), id)).not.toBe(revision)
    await expect(
      addProviderModels(getDb(), id, [{ id: 'stale' }], { expectedUpdatedAt: before.updatedAt }),
    ).rejects.toThrow('connection changed')
    await expect(
      saveProviderConnection(getDb(), {
        id,
        provider: 'otari',
        name: 'Old',
        url: before.url,
        authMethod: 'api_key',
        credentials: { apiKey: 'old' },
        expectedRevision: revision,
      }),
    ).rejects.toThrow('connection changed')
  } finally {
    clock.mockRestore()
  }
})

it.each([
  { expiresAt: -1000, refreshToken: undefined, connected: false },
  { expiresAt: -1000, refreshToken: 'refresh', connected: true },
  { expiresAt: 120000, refreshToken: undefined, connected: true },
])(
  'reports Tinfoil access-only expiry separately from a recoverable refresh',
  async ({ expiresAt, refreshToken, connected }) => {
    await getDb().transaction((tx) =>
      saveProviderConnectionInTransaction(tx, {
        provider: 'tinfoil',
        name: 'Tinfoil',
        authMethod: 'oauth',
        credentials: { access_token: 'access', refresh_token: refreshToken, expires_at: Date.now() + expiresAt },
      }),
    )
    expect((await getProviderConnections(getDb()))[0].connected).toBe(connected)
  },
)
