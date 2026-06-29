/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { deleteMcpServer } from './mcp-servers'
import { getMcpServerCredentials, setMcpServerCredentials } from './mcp-secrets'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('MCP Secrets DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getMcpServerCredentials', () => {
    it('should return null when no row exists', async () => {
      const credentials = await getMcpServerCredentials(getDb(), uuidv7())
      expect(credentials).toBeNull()
    })
  })

  describe('setMcpServerCredentials', () => {
    it('should round-trip the bearer credentials blob', async () => {
      const id = uuidv7()
      await setMcpServerCredentials(getDb(), id, { type: 'bearer', token: 'secret-token' })

      const credentials = await getMcpServerCredentials(getDb(), id)
      expect(credentials).toEqual({ type: 'bearer', token: 'secret-token' })
    })

    it('should round-trip the oauth credentials blob', async () => {
      const id = uuidv7()
      const oauthCredentials = {
        type: 'oauth' as const,
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        expires_at: 1_900_000_000_000,
        clientId: 'client-789',
        issuer: 'https://auth.example.com',
        tokenEndpoint: 'https://auth.example.com/token',
        scope: 'read write',
      }
      await setMcpServerCredentials(getDb(), id, oauthCredentials)

      const credentials = await getMcpServerCredentials(getDb(), id)
      expect(credentials).toEqual(oauthCredentials)
    })

    it('should update an existing row rather than insert a duplicate', async () => {
      const db = getDb()
      const id = uuidv7()

      await setMcpServerCredentials(db, id, { type: 'bearer', token: 'first' })
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 'second' })

      const credentials = await getMcpServerCredentials(db, id)
      expect(credentials).toEqual({ type: 'bearer', token: 'second' })

      const rows = await db.select().from(mcpSecretsTable).where(eq(mcpSecretsTable.id, id))
      expect(rows).toHaveLength(1)
    })
  })

  describe('deleteMcpServer cascade', () => {
    it('should remove the secret row in the same transaction as the server soft-delete', async () => {
      const db = getDb()
      const id = uuidv7()

      await db.insert(mcpServersTable).values({
        id,
        name: 'Authenticated Server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
        workspaceId: wsId,
      })
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 'secret-token' })

      await deleteMcpServer(db, wsId, id)

      const secrets = await db.select().from(mcpSecretsTable)
      expect(secrets).toHaveLength(0)
    })
  })
})
