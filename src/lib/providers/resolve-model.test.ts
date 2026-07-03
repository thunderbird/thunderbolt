/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { createProvider, setProviderCredentials } from '@/dal/providers'
import { hydrateProviderModel } from './resolve-model'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'
import type { Model } from '@/types'

const baseModel = (overrides: Partial<Model>): Model =>
  ({
    id: uuidv7(),
    provider: 'openrouter',
    name: 'M',
    model: 'x/y',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    ...overrides,
  }) as Model

beforeAll(async () => {
  await setupTestDatabase()
})
afterAll(async () => {
  await teardownTestDatabase()
})

describe('hydrateProviderModel', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('returns the model untouched when it has no providerId', async () => {
    const model = baseModel({ apiKey: 'inline-key', providerId: null })
    expect(await hydrateProviderModel(getDb(), wsId, model)).toBe(model)
  })

  it('fills apiKey from the provider secret and url from the provider row', async () => {
    const db = getDb()
    const providerId = uuidv7()
    await createProvider(db, wsId, {
      id: providerId,
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      enabledCapabilities: ['models'],
      userId: testUserId,
    })
    await setProviderCredentials(db, providerId, { apiKey: 'secret-key' })

    const hydrated = await hydrateProviderModel(db, wsId, baseModel({ provider: 'custom', providerId }))
    expect(hydrated.apiKey).toBe('secret-key')
    expect(hydrated.url).toBe('http://localhost:11434/v1')
  })

  it('falls back to the oauth access_token when no apiKey is stored', async () => {
    const db = getDb()
    const providerId = uuidv7()
    await createProvider(db, wsId, {
      id: providerId,
      type: 'openrouter',
      enabledCapabilities: ['models'],
      userId: testUserId,
    })
    await setProviderCredentials(db, providerId, { access_token: 'oauth-tok' })

    const hydrated = await hydrateProviderModel(db, wsId, baseModel({ providerId }))
    expect(hydrated.apiKey).toBe('oauth-tok')
  })
})
