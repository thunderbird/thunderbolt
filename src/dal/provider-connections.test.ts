/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, afterAll, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import * as oauthSession from '@/providers/oauth-session'
import * as chatGPTAuth from '@/providers/chatgpt-auth'
import type { ProviderCredentials } from '@/providers/types'
import { listChatGPTAccounts } from '@/providers/chatgpt-registration'
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

it.each(['metadata-only', 'disconnected'] as const)(
  'preserves the synced OAuth enabled state when renaming a %s connection',
  async (state) => {
    const id = await connect('Otari', 'oauth')
    if (state === 'metadata-only') {
      await getDb().delete(providerConnectionSecretsTable).where(eq(providerConnectionSecretsTable.id, id))
    } else {
      await disconnectProviderConnection(getDb(), id)
    }
    await updateProviderConnection(getDb(), id, { name: 'Renamed' })
    expect(await getProviderConnections(getDb())).toMatchObject([{ name: 'Renamed', enabled: 1, connected: false }])
    if (state === 'metadata-only') {
      expect(await getDb().select().from(providerConnectionSecretsTable)).toEqual([])
    }
    await updateProviderConnection(getDb(), id, { enabled: false })
    await updateProviderConnection(getDb(), id, { enabled: true })
    expect(await getProviderConnections(getDb())).toMatchObject([{ enabled: 1, connected: false }])
  },
)

it('reserves canonical OAuth identities for OAuth authorizations', async () => {
  await expect(
    saveProviderConnection(getDb(), {
      id: 'oauth:tinfoil',
      provider: 'tinfoil',
      name: 'BYOK',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    }),
  ).rejects.toThrow('reserved')
  expect(await getProviderConnections(getDb())).toEqual([])
})

it.each(['api_key', 'oauth'] as const)(
  'preserves the %s session on rename and retires it on enable changes',
  async (authMethod) => {
    const id = await connect('Original', authMethod)
    const initial = await resolveProviderConnection(getDb(), id)
    await updateProviderConnection(getDb(), id, { name: 'Renamed' })
    expect((await resolveProviderConnection(getDb(), id)).revision).toBe(initial.revision)
    await updateProviderConnection(getDb(), id, { enabled: true })
    expect((await resolveProviderConnection(getDb(), id)).revision).toBe(initial.revision)
    await updateProviderConnection(getDb(), id, { enabled: false })
    await updateProviderConnection(getDb(), id, { enabled: true })
    const enabled = await resolveProviderConnection(getDb(), id)
    expect(enabled.revision).not.toBe(initial.revision)
    expect(enabled.apiKey).toBe(initial.apiKey)
  },
)

describe('ChatGPT account switching', () => {
  const credentials = (clientId: string): ProviderCredentials => ({
    access_token: `access:${clientId}`,
    refresh_token: `refresh:${clientId}`,
    oauth: {
      clientId,
      subject: `subject:${clientId}`,
      issuer: 'https://auth.openai.com',
      tokenEndpoint: 'https://auth.openai.com/token',
      resource: 'https://api.openai.com/v1',
      scope: 'chatgpt.tokens.use.direct',
    },
  })
  const save = (next = credentials('first'), extra: Partial<Parameters<typeof saveProviderConnection>[1]> = {}) =>
    saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'ChatGPT',
      authMethod: 'oauth',
      credentials: next,
      ...extra,
    })
  const stored = async () => {
    const row = await getDb()
      .select()
      .from(providerConnectionSecretsTable)
      .where(eq(providerConnectionSecretsTable.id, 'oauth:openai'))
      .get()
    return JSON.parse(row!.credentials!) as ProviderCredentials
  }
  const setupMocks = () => {
    let tail: Promise<unknown> = Promise.resolve()
    const lock = spyOn(oauthSession, 'withProviderOAuthLock').mockImplementation(async (_id, work) => {
      const predecessor = tail
      const released = Promise.withResolvers<void>()
      tail = released.promise
      await predecessor
      try {
        return await work()
      } finally {
        released.resolve()
      }
    })
    const revoke = spyOn(chatGPTAuth, 'revokeChatGPTSession').mockResolvedValue(undefined)
    return { lock, revoke }
  }
  let mocks: ReturnType<typeof setupMocks>
  beforeEach(() => {
    mocks = setupMocks()
  })
  afterEach(() => {
    mocks.lock.mockRestore()
    mocks.revoke.mockRestore()
  })

  it('revokes the previous renewable session and retains only token-free registration metadata', async () => {
    await save()
    mocks.revoke.mockImplementation(async (previous) => {
      expect(previous.refresh_token).toBe('refresh:first')
      expect((await stored()).oauth?.clientId).toBe('first')
    })
    const attempt = await getProviderConnectionAttempt(getDb(), 'openai')
    await save(credentials('second'), { attempt })
    expect(mocks.revoke).toHaveBeenCalledTimes(1)
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toMatchObject({ access_token: 'access:second' })
    expect(await listChatGPTAccounts(getDb())).toEqual([
      expect.objectContaining({ clientId: 'first', active: false }),
      expect.objectContaining({ clientId: 'second', active: true }),
    ])
    const rows = await getDb().select().from(providerConnectionSecretsTable)
    expect(rows.filter((row) => JSON.parse(row.credentials!).refresh_token)).toHaveLength(1)
    for (const row of rows.filter((row) => row.id.startsWith('chatgpt-registration:'))) {
      expect(Object.keys(JSON.parse(row.credentials!))).toEqual(['chatGPTRegistration'])
    }
  })

  it('does not revoke the new grant when reauthorizing the same registered account', async () => {
    await save()
    await save({ ...credentials('first'), refresh_token: 'rotated' })
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect((await stored()).refresh_token).toBe('rotated')
  })

  it('leaves the original connection usable when revocation fails', async () => {
    await save()
    mocks.revoke.mockRejectedValue(new Error('Provider unavailable'))
    await expect(save(credentials('second'))).rejects.toThrow('Provider unavailable')
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toMatchObject({ access_token: 'access:first' })
  })

  it('rejects stale authorization or cancellation before revoking the old account', async () => {
    await save()
    const attempt = await getProviderConnectionAttempt(getDb(), 'openai')
    await updateProviderConnection(getDb(), 'oauth:openai', { name: 'Renamed' })
    await expect(save(credentials('second'), { attempt })).rejects.toThrow('changed')
    await expect(save(credentials('second'), { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it('retires the revoked session even when switching is cancelled during revocation', async () => {
    await save()
    const controller = new AbortController()
    mocks.revoke.mockImplementation(async () => {
      controller.abort()
    })
    await expect(save(credentials('second'), { signal: controller.signal })).rejects.toThrow()
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
    expect(await stored()).toMatchObject({ access_token: 'access:first', reauth_required: true })
    expect((await getProviderConnections(getDb()))[0].connected).toBe(false)
  })

  it.each(['rename', 'disable', 'disable-reenable'] as const)(
    'preserves concurrent %s and retires the revoked session',
    async (change) => {
      await save()
      const attempt = await getProviderConnectionAttempt(getDb(), 'openai')
      mocks.revoke.mockImplementation(async () => {
        if (change === 'rename') {
          await updateProviderConnection(getDb(), 'oauth:openai', { name: 'Renamed' })
          return
        }
        await updateProviderConnection(getDb(), 'oauth:openai', { enabled: false })
        if (change === 'disable-reenable') {
          await updateProviderConnection(getDb(), 'oauth:openai', { enabled: true })
        }
      })
      await expect(save(credentials('second'), { attempt })).rejects.toThrow('changed')
      const [connection] = await getProviderConnections(getDb())
      expect(connection).toMatchObject({
        connected: false,
        enabled: change === 'disable' ? 0 : 1,
        name: change === 'rename' ? 'Renamed' : 'ChatGPT',
      })
      expect(await stored()).toMatchObject({ access_token: 'access:first', reauth_required: true })
    },
  )

  it('can replace the active account with an identity still awaiting plan consent', async () => {
    await save()
    const next = credentials('second')
    next.oauth!.scope = 'openid profile'
    next.reauth_required = true
    await save(next)
    expect(mocks.revoke).toHaveBeenCalledTimes(1)
    expect((await stored()).oauth?.clientId).toBe('second')
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({ connected: false, needsConsent: true })
  })

  it('does not leave a revoked session usable after a toggle during disconnect', async () => {
    await save()
    mocks.revoke.mockImplementation(async () => {
      await updateProviderConnection(getDb(), 'oauth:openai', { enabled: false })
      await updateProviderConnection(getDb(), 'oauth:openai', { enabled: true })
    })
    await disconnectProviderConnection(getDb(), 'oauth:openai')
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
    expect((await stored()).access_token).toBeUndefined()
    expect(await listChatGPTAccounts(getDb())).toEqual([expect.objectContaining({ clientId: 'first', active: false })])
  })

  it('does not revoke when the previous account has no renewable session', async () => {
    await save({ ...credentials('first'), refresh_token: undefined })
    await save(credentials('second'))
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect((await stored()).oauth?.clientId).toBe('second')
  })

  it('validates the replacement before revoking a usable account', async () => {
    await save()
    await expect(save(credentials('second'), { name: '' })).rejects.toThrow('name')
    await expect(save({}, { name: 'ChatGPT' })).rejects.toThrow('credentials')
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).not.toBeNull()
  })

  it('preserves the original account when disconnect revocation fails', async () => {
    await save()
    mocks.revoke.mockRejectedValue(new Error('Provider unavailable'))
    await expect(disconnectProviderConnection(getDb(), 'oauth:openai')).rejects.toThrow('Provider unavailable')
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toMatchObject({ access_token: 'access:first' })
  })

  it('never overwrites a different session that appears during disconnect', async () => {
    await save()
    mocks.revoke.mockImplementation(async () => {
      await getDb().transaction((tx) =>
        saveProviderConnectionInTransaction(tx, {
          provider: 'openai',
          authMethod: 'oauth',
          name: 'New account',
          credentials: credentials('second'),
        }),
      )
    })
    await expect(disconnectProviderConnection(getDb(), 'oauth:openai')).rejects.toThrow('changed')
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toMatchObject({ access_token: 'access:second' })
  })

  it('serializes a disconnect requested during an account switch and disconnects the replacement', async () => {
    await save()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    mocks.revoke.mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
    })
    const switching = save(credentials('second'))
    await started.promise
    const disconnecting = disconnectProviderConnection(getDb(), 'oauth:openai')
    release.resolve()
    await switching
    await disconnecting
    expect(mocks.revoke).toHaveBeenCalledTimes(2)
    expect(mocks.revoke.mock.calls[1][0].refresh_token).toBe('refresh:second')
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
    expect((await stored()).access_token).toBeUndefined()
  })
})
