import { aiFetchStreamingResponse } from '@/src/ai/fetch'
import { migrate } from '@/src/db/migrate'
import { DatabaseSingleton } from '@/src/db/singleton'
import { modelsTable, settingsTable } from '@/src/db/tables'
import type { ThunderboltUIMessage } from '@/src/types'
import { beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'

const makeInit = (messages: ThunderboltUIMessage[], chatId: string): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ messages, chatId }),
})

beforeAll(async () => {
  // Use in-memory database for testing
  await DatabaseSingleton.instance.initialize({ type: 'sqlocal', path: ':memory:' })

  // Run migrations to create tables
  const db = DatabaseSingleton.instance.db
  await migrate(db)
})

describe('Flower provider integration tests', () => {
  it('creates a streaming response for a Flower model', async () => {
    const db = DatabaseSingleton.instance.db

    const modelId = uuidv7()
    await db.insert(modelsTable).values({
      id: modelId,
      provider: 'flower',
      name: 'Qwen 3',
      model: 'qwen/qwen3-235b',
      enabled: 1,
      isSystem: 0,
      toolUsage: 0,
      isConfidential: 1,
    })

    const init = makeInit(
      [{ id: uuidv7(), role: 'user', content: 'Hello', parts: [] } as ThunderboltUIMessage],
      uuidv7(),
    )

    const res = await aiFetchStreamingResponse({ init, modelId, saveMessages: async () => {}, mcpClients: [] })
    expect(res).toBeInstanceOf(Response)
    const reader = res.body?.getReader?.()
    expect(reader).toBeDefined()
  })

  it('supports encryption option for confidential models', async () => {
    const db = DatabaseSingleton.instance.db

    const modelId = uuidv7()
    await db.insert(modelsTable).values({
      id: modelId,
      provider: 'flower',
      name: 'Qwen 3 Encrypted',
      model: 'qwen/qwen3-235b',
      enabled: 1,
      isSystem: 0,
      toolUsage: 0,
      isConfidential: 1,
    })

    const init = makeInit(
      [{ id: uuidv7(), role: 'user', content: 'Sensitive data test', parts: [] } as ThunderboltUIMessage],
      uuidv7(),
    )

    // Test that we can create a response for a confidential model
    // The encryption will be handled internally by the Flower provider
    const res = await aiFetchStreamingResponse({ init, modelId, saveMessages: async () => {}, mcpClients: [] })
    expect(res).toBeInstanceOf(Response)
    const reader = res.body?.getReader?.()
    expect(reader).toBeDefined()
  })

  it('respects disable encryption setting for confidential models', async () => {
    const db = DatabaseSingleton.instance.db

    // Enable the disable encryption setting
    await db
      .insert(settingsTable)
      .values({
        key: 'disable_flower_encryption',
        value: 'true',
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: 'true' },
      })

    const modelId = uuidv7()
    await db.insert(modelsTable).values({
      id: modelId,
      provider: 'flower',
      name: 'Qwen 3 No Encryption',
      model: 'qwen/qwen3-235b',
      enabled: 1,
      isSystem: 0,
      toolUsage: 0,
      isConfidential: 1, // This is confidential but encryption should be disabled
    })

    const init = makeInit(
      [
        {
          id: uuidv7(),
          role: 'user',
          content: 'Sensitive data test without encryption',
          parts: [],
        } as ThunderboltUIMessage,
      ],
      uuidv7(),
    )

    // Test that we can create a response for a confidential model with encryption disabled
    const res = await aiFetchStreamingResponse({ init, modelId, saveMessages: async () => {}, mcpClients: [] })
    expect(res).toBeInstanceOf(Response)
    const reader = res.body?.getReader?.()
    expect(reader).toBeDefined()

    // Reset the setting to default for other tests
    await db
      .insert(settingsTable)
      .values({
        key: 'disable_flower_encryption',
        value: 'false',
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: 'false' },
      })
  })
})
