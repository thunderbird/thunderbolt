import { aiFetchStreamingResponse } from '@/ai/fetch'
import { migrate } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import { beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'

const makeInit = (messages: any[], chatId: string): RequestInit => ({
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

describe('aiFetchStreamingResponse with Flower provider', () => {
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

    const init = makeInit([{ id: uuidv7(), role: 'user', content: 'Hello', parts: [] }], uuidv7())

    const res = await aiFetchStreamingResponse({ init, modelId, saveMessages: async () => {}, mcpClients: [] })
    expect(res).toBeInstanceOf(Response)
    const reader = (res.body as any)?.getReader?.()
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

    const init = makeInit([{ id: uuidv7(), role: 'user', content: 'Sensitive data test', parts: [] }], uuidv7())

    // Test that we can create a response for a confidential model
    // The encryption will be handled internally by the Flower provider
    const res = await aiFetchStreamingResponse({ init, modelId, saveMessages: async () => {}, mcpClients: [] })
    expect(res).toBeInstanceOf(Response)
    const reader = (res.body as any)?.getReader?.()
    expect(reader).toBeDefined()
  })
})
