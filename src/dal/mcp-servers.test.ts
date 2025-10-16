import { DatabaseSingleton } from '@/src/db/singleton'
import { mcpServersTable } from '@/src/db/tables'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getAllMcpServers, getHttpMcpServers } from './mcp-servers'
import { setupTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

describe('MCP Servers DAL', () => {
  afterEach(async () => {
    // Clean up MCP servers table after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(mcpServersTable)
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
})
