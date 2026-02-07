import { DatabaseSingleton } from '@/db/singleton'
import { mcpServersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { createMcpServer, deleteMcpServer, getAllMcpServers, getHttpMcpServers } from './mcp-servers'
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

  describe('getAllMcpServers', () => {
    it('should return empty array when no MCP servers exist', async () => {
      const servers = await getAllMcpServers()
      expect(servers).toEqual([])
    })

    it('should return all MCP servers', async () => {
      const db = DatabaseSingleton.instance.db
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

      const servers = await getAllMcpServers()
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
    })
  })

  describe('getHttpMcpServers', () => {
    it('should return empty array when no HTTP servers exist', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'STDIO Server',
        type: 'stdio',
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toEqual([])
    })

    it('should return only HTTP servers with URLs', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()
      const serverId3 = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: serverId1,
          name: 'HTTP Server 1',
          type: 'http',
          url: 'http://example1.com',
          enabled: 1,
        },
        {
          id: serverId2,
          name: 'HTTP Server 2',
          type: 'http',
          url: 'http://example2.com',
          enabled: 0,
        },
        {
          id: serverId3,
          name: 'STDIO Server',
          type: 'stdio',
          enabled: 1,
        },
      ])

      const servers = await getHttpMcpServers()
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
      expect(servers.map((s) => s.id)).not.toContain(serverId3)
    })
  })

  describe('deleteMcpServer', () => {
    it('should soft delete an MCP server by id (set deletedAt)', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'Server to delete',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      // Verify server exists
      const serversBefore = await getAllMcpServers()
      expect(serversBefore).toHaveLength(1)

      await deleteMcpServer(serverId)

      // Verify server is soft deleted (not in getAllMcpServers)
      const serversAfter = await getAllMcpServers()
      expect(serversAfter).toHaveLength(0)

      // But should still exist in database with deletedAt set
      const rawServers = await db.select().from(mcpServersTable)
      expect(rawServers).toHaveLength(1)
      expect(rawServers[0]?.deletedAt).not.toBeNull()
    })

    it('should not throw when deleting non-existent server', async () => {
      await expect(deleteMcpServer('non-existent-id')).resolves.toBeUndefined()
    })

    it('should only soft delete the specified server', async () => {
      const db = DatabaseSingleton.instance.db
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

      await deleteMcpServer(serverId1)

      // Verify only server 1 is soft deleted (not visible)
      const servers = await getAllMcpServers()
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(serverId2)

      // Both should still exist in database
      const rawServers = await db.select().from(mcpServersTable)
      expect(rawServers).toHaveLength(2)
    })

    it('should not return soft-deleted server via getHttpMcpServers', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'HTTP Server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      // Verify server exists in HTTP servers
      const serversBefore = await getHttpMcpServers()
      expect(serversBefore).toHaveLength(1)

      await deleteMcpServer(serverId)

      // Verify server is not returned after soft deletion
      const serversAfter = await getHttpMcpServers()
      expect(serversAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetime for already-deleted server', async () => {
      const db = DatabaseSingleton.instance.db
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
      await deleteMcpServer(serverId)

      // Verify original deletedAt is preserved
      const rawServer = await db.select().from(mcpServersTable).get()
      expect(rawServer?.deletedAt).toBe(originalDeletedAt)
    })
  })

  describe('createMcpServer', () => {
    it('should create a new MCP server', async () => {
      const serverId = uuidv7()

      await createMcpServer({
        id: serverId,
        name: 'New Server',
        url: 'http://example.com',
        enabled: 1,
      })

      const servers = await getAllMcpServers()
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(serverId)
      expect(servers[0]?.name).toBe('New Server')
    })

    it('should create an HTTP server that appears in getHttpMcpServers', async () => {
      const serverId = uuidv7()

      await createMcpServer({
        id: serverId,
        name: 'HTTP Server',
        type: 'http',
        url: 'http://example.com',
        enabled: 1,
      })

      const httpServers = await getHttpMcpServers()
      expect(httpServers).toHaveLength(1)
      expect(httpServers[0]?.id).toBe(serverId)
    })

    it('should create a stdio server excluded from getHttpMcpServers', async () => {
      const serverId = uuidv7()

      await createMcpServer({
        id: serverId,
        name: 'STDIO Server',
        type: 'stdio',
        enabled: 1,
      })

      const httpServers = await getHttpMcpServers()
      expect(httpServers).toHaveLength(0)

      const allServers = await getAllMcpServers()
      expect(allServers).toHaveLength(1)
    })
  })
})
