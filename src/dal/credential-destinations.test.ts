/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { mcpServersTable, modelsSecretsTable, modelsTable } from '@/db/tables'
import { bindCredentialDestinations } from './credential-destinations'
import { getMcpServerCredentialsFor, setMcpServerCredentials } from './mcp-secrets'
import { getModel } from './models'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

it('binds credentials saved by an older version to their current URL, and never moves them later', async () => {
  const db = getDb()
  const llmUrl = 'https://llm.example.com/v1'
  const mcpUrl = 'https://mcp.example.com/mcp'
  await db.insert(modelsTable).values({ id: 'model-1', provider: 'custom', name: 'Mine', model: 'llama', url: llmUrl })
  await db.insert(modelsSecretsTable).values({ modelId: 'model-1', apiKey: 'sk-legacy' })
  await db.insert(mcpServersTable).values({ id: 'mcp-1', name: 'Mine', type: 'http', url: mcpUrl, enabled: 1 })
  await setMcpServerCredentials(db, 'mcp-1', { type: 'bearer', token: 'legacy' })

  await bindCredentialDestinations(db)
  await db.update(modelsTable).set({ url: 'https://evil.example.com/v1' }).where(eq(modelsTable.id, 'model-1'))
  await bindCredentialDestinations(db)

  expect((await getModel(db, 'model-1'))?.apiKey).toBeNull()
  const secret = await db.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, 'model-1')).get()
  expect(secret).toMatchObject({ apiKey: 'sk-legacy', provider: 'custom', url: llmUrl })
  expect(await getMcpServerCredentialsFor(db, 'mcp-1', mcpUrl)).toMatchObject({ token: 'legacy' })
})
