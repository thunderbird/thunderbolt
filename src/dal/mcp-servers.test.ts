/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { mcpServersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createMcpServer,
  createMcpServersWithCredentials,
  createMcpServerWithCredentials,
  deleteMcpServer,
  getAllMcpServers,
  getRemoteMcpServers,
  updateMcpServerWithCredentials,
} from './mcp-servers'
import { getMcpServerCredentials } from './mcp-secrets'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('MCP Servers DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  describe('createMcpServerWithCredentials', () => {
    it('writes the server row and its credential together', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(
        db,
        { id, name: 'Auth Server', type: 'http', url: 'https://example.com/mcp', enabled: 1 },
        { type: 'bearer', token: 'secret-token' },
      )
      const servers = await getAllMcpServers(db)
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(id)
      expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'bearer', token: 'secret-token' })
    })

    it('writes the server row with no credential when none is given', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(db, {
        id,
        name: 'No-Auth Server',
        type: 'http',
        url: 'https://example.com/mcp',
        enabled: 1,
      })
      expect(await getAllMcpServers(db)).toHaveLength(1)
      expect(await getMcpServerCredentials(db, id)).toBeNull()
    })
  })

  describe('createMcpServersWithCredentials', () => {
    it('batch-creates servers with and without credentials in one transaction', async () => {
      const db = getDb()
      const withCredId = uuidv7()
      const noCredId = uuidv7()
      await createMcpServersWithCredentials(db, [
        {
          server: { id: withCredId, name: 'Bearer Server', type: 'http', url: 'https://a.example.com/mcp', enabled: 1 },
          credential: { type: 'bearer', token: 'secret-token' },
        },
        {
          server: { id: noCredId, name: 'No-Auth Server', type: 'sse', url: 'https://b.example.com/mcp', enabled: 0 },
        },
      ])

      const servers = await getAllMcpServers(db)
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(withCredId)
      expect(servers.map((s) => s.id)).toContain(noCredId)
      expect(await getMcpServerCredentials(db, withCredId)).toEqual({ type: 'bearer', token: 'secret-token' })
      expect(await getMcpServerCredentials(db, noCredId)).toBeNull()
    })

    it('rolls back every row and secret when any item fails', async () => {
      const db = getDb()
      await db
        .insert(mcpServersTable)
        .values({ id: 'dup', name: 'Pre-existing', type: 'http', url: 'https://pre.example.com/mcp', enabled: 1 })

      const goodId = uuidv7()
      await expect(
        createMcpServersWithCredentials(db, [
          {
            server: { id: goodId, name: 'Good Server', type: 'http', url: 'https://good.example.com/mcp', enabled: 1 },
            credential: { type: 'bearer', token: 'secret-token' },
          },
          {
            server: {
              id: 'dup',
              name: 'Duplicate Server',
              type: 'http',
              url: 'https://dup.example.com/mcp',
              enabled: 1,
            },
          },
        ]),
      ).rejects.toThrow()

      const servers = await getAllMcpServers(db)
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe('dup')
      expect(servers.map((s) => s.id)).not.toContain(goodId)
      expect(await getMcpServerCredentials(db, goodId)).toBeNull()
    })
  })

  describe('getAllMcpServers', () => {
    it('should return empty array when no MCP servers exist', async () => {
      const servers = await getAllMcpServers(getDb())
      expect(servers).toEqual([])
    })

    it('should return all MCP servers', async () => {
      const db = getDb()
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: serverId1,
          name: 'Server 1',
          type: 'stdio',
          enabled: 1,
        },
        {
          id: serverId2,
          name: 'Server 2',
          type: 'http',
          url: 'http://example.com',
          enabled: 0,
        },
      ])

      const servers = await getAllMcpServers(getDb())
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
    })
  })

  describe('getRemoteMcpServers', () => {
    it('should return empty array when no remote servers exist', async () => {
      const db = getDb()
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'STDIO Server',
        type: 'stdio',
        enabled: 1,
      })

      const servers = await getRemoteMcpServers(getDb())
      expect(servers).toEqual([])
    })

    it('should return HTTP and SSE servers with URLs, excluding stdio', async () => {
      const db = getDb()
      const httpId = uuidv7()
      const sseId = uuidv7()
      const stdioId = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: httpId,
          name: 'HTTP Server',
          type: 'http',
          url: 'http://example1.com',
          enabled: 1,
        },
        {
          id: sseId,
          name: 'SSE Server',
          type: 'sse',
          url: 'http://example2.com',
          enabled: 0,
        },
        {
          id: stdioId,
          name: 'STDIO Server',
          type: 'stdio',
          enabled: 1,
        },
      ])

      const servers = await getRemoteMcpServers(getDb())
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(httpId)
      expect(servers.map((s) => s.id)).toContain(sseId)
      expect(servers.map((s) => s.id)).not.toContain(stdioId)
    })
  })

  describe('deleteMcpServer', () => {
    it('should soft delete an MCP server by id (set deletedAt)', async () => {
      const db = getDb()
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'Server to delete',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      // Verify server exists
      const serversBefore = await getAllMcpServers(getDb())
      expect(serversBefore).toHaveLength(1)

      await deleteMcpServer(getDb(), serverId)

      // Verify server is soft deleted (not in getAllMcpServers)
      const serversAfter = await getAllMcpServers(getDb())
      expect(serversAfter).toHaveLength(0)

      // But should still exist in database with deletedAt set
      const rawServers = await db.select().from(mcpServersTable)
      expect(rawServers).toHaveLength(1)
      expect(rawServers[0]?.deletedAt).not.toBeNull()
    })

    it('should not throw when deleting non-existent server', async () => {
      await expect(deleteMcpServer(getDb(), 'non-existent-id')).resolves.toBeUndefined()
    })

    it('should only soft delete the specified server', async () => {
      const db = getDb()
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: serverId1,
          name: 'Server 1',
          type: 'http',
          url: 'http://example1.com',
          enabled: 1,
        },
        {
          id: serverId2,
          name: 'Server 2',
          type: 'stdio',
          enabled: 1,
        },
      ])

      await deleteMcpServer(getDb(), serverId1)

      // Verify only server 1 is soft deleted (not visible)
      const servers = await getAllMcpServers(getDb())
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(serverId2)

      // Both should still exist in database
      const rawServers = await db.select().from(mcpServersTable)
      expect(rawServers).toHaveLength(2)
    })

    it('should not return soft-deleted server via getRemoteMcpServers', async () => {
      const db = getDb()
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'HTTP Server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      // Verify server exists in remote servers
      const serversBefore = await getRemoteMcpServers(getDb())
      expect(serversBefore).toHaveLength(1)

      await deleteMcpServer(getDb(), serverId)

      // Verify server is not returned after soft deletion
      const serversAfter = await getRemoteMcpServers(getDb())
      expect(serversAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetime for already-deleted server', async () => {
      const db = getDb()
      const serverId = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'Already deleted server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
        deletedAt: originalDeletedAt,
      })

      // Call delete again on already-deleted server
      await deleteMcpServer(getDb(), serverId)

      // Verify original deletedAt is preserved
      const rawServer = await db.select().from(mcpServersTable).get()
      expect(rawServer?.deletedAt).toBe(originalDeletedAt)
    })
  })

  describe('updateMcpServerWithCredentials', () => {
    it('patches mutable fields and leaves credentials alone when none given', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(
        db,
        { id, name: 'Original', type: 'http', url: 'https://example.com/mcp', enabled: 1 },
        { type: 'bearer', token: 'original-token' },
      )

      await updateMcpServerWithCredentials(db, id, { name: 'Renamed', url: 'https://new.example.com/mcp' })

      const servers = await getAllMcpServers(db)
      expect(servers[0]?.name).toBe('Renamed')
      expect(servers[0]?.url).toBe('https://new.example.com/mcp')
      expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'bearer', token: 'original-token' })
    })

    it('replaces the credential when an object is given', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(
        db,
        { id, name: 'Server', type: 'http', url: 'https://example.com/mcp', enabled: 1 },
        { type: 'bearer', token: 'old-token' },
      )

      await updateMcpServerWithCredentials(db, id, { name: 'Server' }, { type: 'bearer', token: 'new-token' })

      expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'bearer', token: 'new-token' })
    })

    it('deletes the credential when null is given', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(
        db,
        { id, name: 'Server', type: 'http', url: 'https://example.com/mcp', enabled: 1 },
        { type: 'bearer', token: 'doomed' },
      )

      await updateMcpServerWithCredentials(db, id, { name: 'Server' }, null)

      expect(await getMcpServerCredentials(db, id)).toBeNull()
    })

    it('adds a credential to a previously-uncredentialed server', async () => {
      const db = getDb()
      const id = uuidv7()
      await createMcpServerWithCredentials(db, {
        id,
        name: 'Open Server',
        type: 'http',
        url: 'https://example.com/mcp',
        enabled: 1,
      })

      await updateMcpServerWithCredentials(db, id, {}, { type: 'bearer', token: 'fresh' })

      expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'bearer', token: 'fresh' })
    })
  })

  describe('createMcpServer', () => {
    it('should create a new MCP server', async () => {
      const serverId = uuidv7()

      await createMcpServer(getDb(), {
        id: serverId,
        name: 'New Server',
        url: 'http://example.com',
        enabled: 1,
      })

      const servers = await getAllMcpServers(getDb())
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(serverId)
      expect(servers[0]?.name).toBe('New Server')
    })

    it('should create an HTTP server that appears in getRemoteMcpServers', async () => {
      const serverId = uuidv7()

      await createMcpServer(getDb(), {
        id: serverId,
        name: 'HTTP Server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      const remoteServers = await getRemoteMcpServers(getDb())
      expect(remoteServers).toHaveLength(1)
      expect(remoteServers[0]?.id).toBe(serverId)
    })

    it('should create a stdio server excluded from getRemoteMcpServers', async () => {
      const serverId = uuidv7()

      await createMcpServer(getDb(), {
        id: serverId,
        name: 'STDIO Server',
        type: 'stdio',
        enabled: 1,
      })

      const remoteServers = await getRemoteMcpServers(getDb())
      expect(remoteServers).toHaveLength(0)

      const allServers = await getAllMcpServers(getDb())
      expect(allServers).toHaveLength(1)
    })
  })
})
