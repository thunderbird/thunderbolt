/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { deleteMcpServer } from './mcp-servers'
import {
  bindUnboundMcpCredentials,
  getMcpServerCredentialRows,
  getMcpServerCredentials,
  getMcpServerCredentialsFor,
  getMcpServerCredentialSnapshot,
  parseMcpCredentialSummary,
  setMcpServerCredentials,
  updateMcpServerCredentialsIfCurrent,
} from './mcp-secrets'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

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

    it('preserves exact credential bytes in a snapshot and rejects a changed representation', async () => {
      const db = getDb()
      const id = uuidv7()
      const url = 'https://mcp.example.com/sse'
      await db.insert(mcpServersTable).values({ id, name: 'MCP', url, enabled: 1 })
      const serialized = ' { "type": "oauth", "access_token": "original" } '
      await db.insert(mcpSecretsTable).values({ id, credentials: serialized })
      const snapshot = await getMcpServerCredentialSnapshot(db, id)
      expect(snapshot).toEqual({ serialized, credentials: { type: 'oauth', access_token: 'original' } })

      await setMcpServerCredentials(db, id, snapshot!.credentials)
      await expect(
        updateMcpServerCredentialsIfCurrent(
          db,
          id,
          { type: 'oauth', access_token: 'replacement' },
          {
            expectedCredentials: snapshot!.serialized,
            expectedUrl: url,
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow('changed during token refresh')
      expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'oauth', access_token: 'original' })
    })
  })

  describe('settings credential summaries', () => {
    const addServer = (id: string, url: string) =>
      getDb().insert(mcpServersTable).values({ id, name: 'Server', type: 'http', url, enabled: 1 })

    it('reads and narrows bearer credentials through the DAL boundary', async () => {
      const id = uuidv7()
      await addServer(id, 'https://mcp.example.com/mcp')
      await setMcpServerCredentials(getDb(), id, {
        type: 'bearer',
        token: 'secret-token',
        approvedUrl: 'https://mcp.example.com/mcp',
      })

      const rows = await getMcpServerCredentialRows(getDb())

      expect(rows).toHaveLength(1)
      expect(parseMcpCredentialSummary(rows[0]!)).toEqual({
        id,
        type: 'bearer',
        bearerToken: 'secret-token',
      })
    })

    it('drops a credential saved for another URL than the server has now', async () => {
      const db = getDb()
      const moved = uuidv7()
      const unbound = uuidv7()
      await addServer(moved, 'https://evil.example.com/mcp')
      await addServer(unbound, 'https://mcp.example.com/mcp')
      await setMcpServerCredentials(db, moved, {
        type: 'bearer',
        token: 'secret-token',
        approvedUrl: 'https://mcp.example.com/mcp',
      })
      await setMcpServerCredentials(db, unbound, { type: 'oauth', access_token: 'access' })

      const rows = await getMcpServerCredentialRows(db)

      expect(rows.map(parseMcpCredentialSummary)).toEqual([null, null])
    })
  })

  describe('getMcpServerCredentialsFor', () => {
    it('returns the credential only for the URL it was saved for', async () => {
      const db = getDb()
      const id = uuidv7()
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 't', approvedUrl: 'https://mcp.example.com/mcp' })

      expect(await getMcpServerCredentialsFor(db, id, 'https://MCP.example.com:443/mcp')).toMatchObject({ token: 't' })
      expect(await getMcpServerCredentialsFor(db, id, 'https://mcp.example.com/mcp/')).toBeNull()
      expect(await getMcpServerCredentialsFor(db, id, 'https://evil.example.com/mcp')).toBeNull()
      expect(await getMcpServerCredentialsFor(db, id, 'http://mcp.example.com/mcp')).toBeNull()
    })

    it('never returns a credential saved before binding', async () => {
      const db = getDb()
      const id = uuidv7()
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 't' })

      expect(await getMcpServerCredentialsFor(db, id, 'https://mcp.example.com/mcp')).toBeNull()
    })
  })

  describe('bindUnboundMcpCredentials', () => {
    it('binds credentials saved before binding to the server URL and drops orphans', async () => {
      const db = getDb()
      const id = uuidv7()
      await db
        .insert(mcpServersTable)
        .values({ id, name: 'Server', type: 'http', url: 'https://mcp.example.com/mcp', enabled: 1 })
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 'legacy' })
      await setMcpServerCredentials(db, 'gone', { type: 'bearer', token: 'orphan' })

      await bindUnboundMcpCredentials(db)

      expect(await getMcpServerCredentials(db, id)).toEqual({
        type: 'bearer',
        token: 'legacy',
        approvedUrl: 'https://mcp.example.com/mcp',
      })
      expect(await getMcpServerCredentials(db, 'gone')).toBeNull()
    })

    it('leaves a credential bound to an old URL where it is', async () => {
      const db = getDb()
      const id = uuidv7()
      await db
        .insert(mcpServersTable)
        .values({ id, name: 'Server', type: 'http', url: 'https://evil.example.com/mcp', enabled: 1 })
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 't', approvedUrl: 'https://mcp.example.com/mcp' })

      await bindUnboundMcpCredentials(db)

      expect((await getMcpServerCredentials(db, id))?.approvedUrl).toBe('https://mcp.example.com/mcp')
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
      })
      await setMcpServerCredentials(db, id, { type: 'bearer', token: 'secret-token' })

      await deleteMcpServer(db, id)

      const secrets = await db.select().from(mcpSecretsTable)
      expect(secrets).toHaveLength(0)
    })
  })
})
