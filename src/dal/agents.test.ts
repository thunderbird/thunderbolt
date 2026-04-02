import { getDb } from '@/db/database'
import { agentsTable, settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  getAllAgents,
  getAvailableAgents,
  getAgent,
  getSelectedAgent,
  installRegistryAgent,
  uninstallRegistryAgent,
  toggleAgent,
  getInstalledRegistryAgents,
  addCustomAgent,
  addRemoteAgent,
} from './agents'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Agents DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getAllAgents', () => {
    it('should return empty array when no agents exist', async () => {
      const agents = await getAllAgents(getDb())
      expect(agents).toEqual([])
    })

    it('should return all agents excluding soft-deleted', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Agent 1', type: 'built-in', transport: 'in-process', isSystem: 1 },
        { id: uuidv7(), name: 'Agent 2', type: 'local', transport: 'stdio' },
        { id: uuidv7(), name: 'Deleted', type: 'remote', transport: 'websocket', deletedAt: new Date().toISOString() },
      ])

      const agents = await getAllAgents(getDb())
      expect(agents).toHaveLength(2)
    })

    it('should sort system agents first', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Custom Agent', type: 'remote', transport: 'websocket', isSystem: 0 },
        { id: uuidv7(), name: 'Built-in', type: 'built-in', transport: 'in-process', isSystem: 1 },
      ])

      const agents = await getAllAgents(getDb())
      expect(agents[0].name).toBe('Built-in')
      expect(agents[1].name).toBe('Custom Agent')
    })
  })

  describe('getAvailableAgents', () => {
    it('should return only enabled agents', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Enabled', type: 'built-in', transport: 'in-process', enabled: 1 },
        { id: uuidv7(), name: 'Disabled', type: 'local', transport: 'stdio', enabled: 0 },
      ])

      const agents = await getAvailableAgents(getDb())
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Enabled')
    })
  })

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const db = getDb()
      const id = uuidv7()
      await db.insert(agentsTable).values({ id, name: 'My Agent', type: 'remote', transport: 'websocket' })

      const agent = await getAgent(getDb(), id)
      expect(agent).toBeDefined()
      expect(agent!.name).toBe('My Agent')
    })

    it('should return undefined for non-existent id', async () => {
      const agent = await getAgent(getDb(), 'nonexistent')
      expect(agent).toBeUndefined()
    })

    it('should not return soft-deleted agents', async () => {
      const db = getDb()
      const id = uuidv7()
      await db
        .insert(agentsTable)
        .values({ id, name: 'Deleted', type: 'local', transport: 'stdio', deletedAt: new Date().toISOString() })

      const agent = await getAgent(getDb(), id)
      expect(agent).toBeUndefined()
    })
  })

  describe('getSelectedAgent', () => {
    it('should return built-in agent when no selection exists', async () => {
      const db = getDb()
      await db
        .insert(agentsTable)
        .values({ id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Thunderbolt')
      expect(agent!.type).toBe('built-in')
    })

    it('should return selected agent from settings', async () => {
      const db = getDb()
      const agentId = uuidv7()
      await db.insert(agentsTable).values([
        { id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 },
        { id: agentId, name: 'Claude Code', type: 'local', transport: 'stdio' },
      ])
      await db.insert(settingsTable).values({ key: 'selected_agent', value: agentId })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Claude Code')
    })

    it('should fall back to built-in when selected agent is deleted', async () => {
      const db = getDb()
      const agentId = uuidv7()
      await db.insert(agentsTable).values([
        { id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 },
        {
          id: agentId,
          name: 'Deleted Agent',
          type: 'remote',
          transport: 'websocket',
          deletedAt: new Date().toISOString(),
        },
      ])
      await db.insert(settingsTable).values({ key: 'selected_agent', value: agentId })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Thunderbolt')
    })
  })

  describe('installRegistryAgent', () => {
    it('inserts agent with all registry metadata', async () => {
      const agent = await installRegistryAgent(getDb(), {
        registryId: 'claude-acp',
        name: 'Claude Agent',
        description: 'Claude Code ACP adapter',
        version: '0.24.2',
        distributionType: 'npx',
        installPath: '/mock/agents/claude-acp',
        packageName: '@agentclientprotocol/claude-agent-acp@0.24.2',
        command: '/mock/agents/claude-acp/node_modules/.bin/claude-agent-acp',
        args: ['--acp'],
        icon: 'terminal',
      })

      expect(agent).toBeDefined()
      expect(agent.registryId).toBe('claude-acp')
      expect(agent.name).toBe('Claude Agent')
      expect(agent.type).toBe('local')
      expect(agent.transport).toBe('stdio')
      expect(agent.enabled).toBe(1)
      expect(agent.installedVersion).toBe('0.24.2')
      expect(agent.registryVersion).toBe('0.24.2')
      expect(agent.distributionType).toBe('npx')
      expect(agent.installPath).toBe('/mock/agents/claude-acp')
      expect(agent.packageName).toBe('@agentclientprotocol/claude-agent-acp@0.24.2')
      expect(agent.description).toBe('Claude Code ACP adapter')
    })

    it('generates deterministic id from registryId', async () => {
      const agent = await installRegistryAgent(getDb(), {
        registryId: 'claude-acp',
        name: 'Claude Agent',
        version: '0.24.2',
        distributionType: 'npx',
        installPath: '/mock/agents/claude-acp',
        command: '/mock/agents/claude-acp/bin/agent',
      })

      expect(agent.id).toBe('agent-registry-claude-acp')
    })

    it('updates existing agent on duplicate registryId', async () => {
      const db = getDb()
      const params = {
        registryId: 'claude-acp',
        name: 'Claude Agent',
        version: '0.24.2',
        distributionType: 'npx' as const,
        installPath: '/mock/agents/claude-acp',
        command: '/mock/agents/claude-acp/bin/agent',
      }

      await installRegistryAgent(db, params)
      const updated = await installRegistryAgent(db, {
        ...params,
        name: 'Claude Agent v2',
        version: '0.25.0',
        command: '/mock/agents/claude-acp/bin/agent-v2',
      })

      expect(updated.id).toBe('agent-registry-claude-acp')
      expect(updated.name).toBe('Claude Agent v2')
      expect(updated.installedVersion).toBe('0.25.0')
      expect(updated.command).toBe('/mock/agents/claude-acp/bin/agent-v2')
    })

    it('re-enables a soft-deleted agent on reinstall', async () => {
      const db = getDb()
      const params = {
        registryId: 'claude-acp',
        name: 'Claude Agent',
        version: '0.24.2',
        distributionType: 'npx' as const,
        installPath: '/mock/agents/claude-acp',
        command: '/mock/agents/claude-acp/bin/agent',
      }

      await installRegistryAgent(db, params)
      // Soft-delete
      await db
        .update(agentsTable)
        .set({ deletedAt: new Date().toISOString(), enabled: 0 })
        .where(eq(agentsTable.id, 'agent-registry-claude-acp'))

      const reinstalled = await installRegistryAgent(db, params)
      expect(reinstalled.deletedAt).toBeNull()
      expect(reinstalled.enabled).toBe(1)
    })
  })

  describe('uninstallRegistryAgent', () => {
    it('hard-deletes the agent and returns true', async () => {
      const db = getDb()
      await installRegistryAgent(db, {
        registryId: 'claude-acp',
        name: 'Claude Agent',
        version: '0.24.2',
        distributionType: 'npx',
        installPath: '/mock/agents/claude-acp',
        command: '/mock/agents/claude-acp/bin/agent',
      })

      const result = await uninstallRegistryAgent(db, 'agent-registry-claude-acp')
      expect(result).toBe(true)

      const agent = await getAgent(db, 'agent-registry-claude-acp')
      expect(agent).toBeUndefined()
    })

    it('returns false for nonexistent agent', async () => {
      const result = await uninstallRegistryAgent(getDb(), 'nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('toggleAgent', () => {
    it('disables an enabled agent', async () => {
      const db = getDb()
      const id = uuidv7()
      await db.insert(agentsTable).values({ id, name: 'Agent', type: 'local', transport: 'stdio', enabled: 1 })

      const result = await toggleAgent(db, id, false)
      expect(result).toBeDefined()
      expect(result!.enabled).toBe(0)
    })

    it('enables a disabled agent', async () => {
      const db = getDb()
      const id = uuidv7()
      await db.insert(agentsTable).values({ id, name: 'Agent', type: 'local', transport: 'stdio', enabled: 0 })

      const result = await toggleAgent(db, id, true)
      expect(result).toBeDefined()
      expect(result!.enabled).toBe(1)
    })

    it('returns undefined for nonexistent agent', async () => {
      const result = await toggleAgent(getDb(), 'nonexistent', true)
      expect(result).toBeUndefined()
    })
  })

  describe('getInstalledRegistryAgents', () => {
    it('returns only agents with non-null registryId', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1, enabled: 1 },
        {
          id: 'agent-registry-claude-acp',
          name: 'Claude Agent',
          type: 'local',
          transport: 'stdio',
          enabled: 1,
          registryId: 'claude-acp',
        },
      ])

      const registryAgents = await getInstalledRegistryAgents(db)
      expect(registryAgents).toHaveLength(1)
      expect(registryAgents[0].registryId).toBe('claude-acp')
    })

    it('excludes soft-deleted agents', async () => {
      const db = getDb()
      await db.insert(agentsTable).values({
        id: 'agent-registry-deleted',
        name: 'Deleted',
        type: 'local',
        transport: 'stdio',
        enabled: 1,
        registryId: 'deleted-agent',
        deletedAt: new Date().toISOString(),
      })

      const registryAgents = await getInstalledRegistryAgents(db)
      expect(registryAgents).toHaveLength(0)
    })

    it('returns empty array when no registry agents exist', async () => {
      const registryAgents = await getInstalledRegistryAgents(getDb())
      expect(registryAgents).toHaveLength(0)
    })
  })

  describe('addCustomAgent', () => {
    it('inserts with type=local, transport=stdio, distributionType=custom', async () => {
      const agent = await addCustomAgent(getDb(), {
        name: 'My Agent',
        command: '/usr/local/bin/my-agent',
      })

      expect(agent).toBeDefined()
      expect(agent.name).toBe('My Agent')
      expect(agent.type).toBe('local')
      expect(agent.transport).toBe('stdio')
      expect(agent.distributionType).toBe('custom')
      expect(agent.command).toBe('/usr/local/bin/my-agent')
      expect(agent.enabled).toBe(1)
      expect(agent.registryId).toBeNull()
    })

    it('accepts optional args', async () => {
      const agent = await addCustomAgent(getDb(), {
        name: 'My Agent',
        command: '/usr/local/bin/my-agent',
        args: ['--acp', '--verbose'],
      })

      expect(agent.args).toBe(JSON.stringify(['--acp', '--verbose']))
    })

    it('accepts optional description', async () => {
      const agent = await addCustomAgent(getDb(), {
        name: 'My Agent',
        command: '/usr/local/bin/my-agent',
        description: 'A custom agent for testing',
      })

      expect(agent.description).toBe('A custom agent for testing')
    })
  })

  describe('getAvailableAgents with registry agents', () => {
    it('includes both registry and custom local agents when enabled', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Thunderbolt', type: 'built-in', transport: 'in-process', enabled: 1, isSystem: 1 },
        {
          id: 'agent-registry-claude',
          name: 'Claude',
          type: 'local',
          transport: 'stdio',
          enabled: 1,
          registryId: 'claude-acp',
        },
        {
          id: uuidv7(),
          name: 'Custom',
          type: 'local',
          transport: 'stdio',
          enabled: 1,
          distributionType: 'custom',
        },
      ])

      const agents = await getAvailableAgents(db)
      expect(agents).toHaveLength(3)
    })

    it('excludes disabled registry agents', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Thunderbolt', type: 'built-in', transport: 'in-process', enabled: 1, isSystem: 1 },
        {
          id: 'agent-registry-claude',
          name: 'Claude',
          type: 'local',
          transport: 'stdio',
          enabled: 0,
          registryId: 'claude-acp',
        },
      ])

      const agents = await getAvailableAgents(db)
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Thunderbolt')
    })
  })

  describe('addRemoteAgent', () => {
    it('inserts with type=remote, transport=websocket, distributionType=remote', async () => {
      const agent = await addRemoteAgent(getDb(), {
        name: 'My Remote Agent',
        url: 'wss://example.com/agent/ws',
      })

      expect(agent).toBeDefined()
      expect(agent.name).toBe('My Remote Agent')
      expect(agent.type).toBe('remote')
      expect(agent.transport).toBe('websocket')
      expect(agent.url).toBe('wss://example.com/agent/ws')
      expect((agent as any).distributionType).toBe('remote')
      expect(agent.enabled).toBe(1)
    })

    it('accepts optional description', async () => {
      const agent = await addRemoteAgent(getDb(), {
        name: 'My Remote Agent',
        url: 'wss://example.com/agent/ws',
        description: 'A test remote agent',
      })

      expect((agent as any).description).toBe('A test remote agent')
    })
  })
})
