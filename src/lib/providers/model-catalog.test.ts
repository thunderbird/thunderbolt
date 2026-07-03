/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modelsTable } from '@/db/tables'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { createProvider } from '@/dal/providers'
import { disableCatalogModel, enableCatalogModel, toggleCatalogModel } from './model-catalog'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'

const seedProvider = async (type: 'openrouter' | 'ollama' = 'openrouter') => {
  const id = uuidv7()
  await createProvider(getDb(), wsId, { id, type, enabledCapabilities: ['models'], userId: testUserId })
  return id
}

const activeModels = () =>
  getDb()
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.workspaceId, wsId), isNull(modelsTable.deletedAt)))

beforeAll(async () => {
  await setupTestDatabase()
})
afterAll(async () => {
  await teardownTestDatabase()
})

describe('model catalog toggle', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('enabling a catalog model creates a curated row with the provider enum + providerId', async () => {
    const providerId = await seedProvider('openrouter')
    const rowId = await enableCatalogModel(getDb(), wsId, {
      providerId,
      providerType: 'openrouter',
      catalogModel: { id: 'anthropic/claude-3.5', name: 'Claude 3.5', contextWindow: 200000 },
      userId: testUserId,
    })

    const rows = await activeModels()
    const created = rows.find((r) => r.id === rowId)
    expect(created).toBeDefined()
    expect(created).toMatchObject({
      provider: 'openrouter',
      providerId,
      model: 'anthropic/claude-3.5',
      name: 'Claude 3.5',
      enabled: 1,
      contextWindow: 200000,
    })
  })

  it('maps an Ollama provider onto the OpenAI-compatible custom enum', async () => {
    const providerId = await seedProvider('ollama')
    const rowId = await enableCatalogModel(getDb(), wsId, {
      providerId,
      providerType: 'ollama',
      catalogModel: { id: 'llama3' },
      userId: testUserId,
    })
    const rows = await activeModels()
    expect(rows.find((r) => r.id === rowId)?.provider).toBe('custom')
  })

  it('is idempotent — re-enabling returns the same row and does not duplicate', async () => {
    const providerId = await seedProvider()
    const first = await enableCatalogModel(getDb(), wsId, {
      providerId,
      providerType: 'openrouter',
      catalogModel: { id: 'x/y' },
      userId: testUserId,
    })
    const before = (await activeModels()).length
    const second = await enableCatalogModel(getDb(), wsId, {
      providerId,
      providerType: 'openrouter',
      catalogModel: { id: 'x/y' },
      userId: testUserId,
    })
    expect(second).toBe(first)
    expect((await activeModels()).length).toBe(before)
  })

  it('disabling soft-deletes the curated row', async () => {
    const providerId = await seedProvider()
    await enableCatalogModel(getDb(), wsId, {
      providerId,
      providerType: 'openrouter',
      catalogModel: { id: 'x/y' },
      userId: testUserId,
    })
    await disableCatalogModel(getDb(), wsId, providerId, 'x/y')
    expect(await activeModels()).toHaveLength(0)
  })

  it('toggleCatalogModel routes on/off', async () => {
    const providerId = await seedProvider()
    const input = {
      providerId,
      providerType: 'openrouter' as const,
      catalogModel: { id: 'x/y' },
      userId: testUserId,
    }
    await toggleCatalogModel(getDb(), wsId, input, true)
    expect(await activeModels()).toHaveLength(1)
    await toggleCatalogModel(getDb(), wsId, input, false)
    expect(await activeModels()).toHaveLength(0)
  })
})
