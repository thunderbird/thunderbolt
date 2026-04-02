import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { agentsTable } from '@/db/tables'
import { eq, isNotNull, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

describe('agents table schema — new registry columns', () => {
  it('accepts all new registry fields', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'Claude Agent',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      isSystem: 0,
      registryId: 'claude-acp',
      installedVersion: '0.24.2',
      registryVersion: '0.24.2',
      distributionType: 'npx',
      installPath: '/mock/app-data/agents/claude-acp',
      packageName: '@agentclientprotocol/claude-agent-acp@0.24.2',
      description: 'Claude Code ACP adapter',
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result).toBeDefined()
    expect(result!.registryId).toBe('claude-acp')
    expect(result!.installedVersion).toBe('0.24.2')
    expect(result!.registryVersion).toBe('0.24.2')
    expect(result!.distributionType).toBe('npx')
    expect(result!.installPath).toBe('/mock/app-data/agents/claude-acp')
    expect(result!.packageName).toBe('@agentclientprotocol/claude-agent-acp@0.24.2')
    expect(result!.description).toBe('Claude Code ACP adapter')
  })

  it('new columns are nullable — existing agents work without them', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'Thunderbolt',
      type: 'built-in',
      transport: 'in-process',
      enabled: 1,
      isSystem: 1,
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result).toBeDefined()
    expect(result!.registryId).toBeNull()
    expect(result!.installedVersion).toBeNull()
    expect(result!.registryVersion).toBeNull()
    expect(result!.distributionType).toBeNull()
    expect(result!.installPath).toBeNull()
    expect(result!.packageName).toBeNull()
    expect(result!.description).toBeNull()
  })

  it('can filter agents by registryId', async () => {
    const db = getDb()

    // Insert a registry agent
    await db.insert(agentsTable).values({
      id: uuidv7(),
      name: 'Claude Agent',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      registryId: 'claude-acp',
    })

    // Insert a non-registry agent
    await db.insert(agentsTable).values({
      id: uuidv7(),
      name: 'Thunderbolt',
      type: 'built-in',
      transport: 'in-process',
      enabled: 1,
    })

    const registryAgents = await db.select().from(agentsTable).where(isNotNull(agentsTable.registryId))
    expect(registryAgents).toHaveLength(1)
    expect(registryAgents[0].name).toBe('Claude Agent')

    const nonRegistryAgents = await db.select().from(agentsTable).where(isNull(agentsTable.registryId))
    expect(nonRegistryAgents).toHaveLength(1)
    expect(nonRegistryAgents[0].name).toBe('Thunderbolt')
  })

  it('can store binary distribution type', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'Goose',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      registryId: 'goose',
      distributionType: 'binary',
      installPath: '/mock/app-data/agents/goose',
      packageName: 'https://example.com/goose-darwin-arm64.tar.gz',
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result!.distributionType).toBe('binary')
  })

  it('can store uvx distribution type', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'fast-agent',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      registryId: 'fast-agent',
      distributionType: 'uvx',
      packageName: 'fast-agent@0.6.10',
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result!.distributionType).toBe('uvx')
  })

  it('can store custom distribution type', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'My Custom Agent',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      distributionType: 'custom',
      command: '/usr/local/bin/my-agent',
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result!.distributionType).toBe('custom')
    expect(result!.registryId).toBeNull()
  })

  it('can update registryVersion independently of installedVersion', async () => {
    const db = getDb()
    const id = uuidv7()

    await db.insert(agentsTable).values({
      id,
      name: 'Claude Agent',
      type: 'local',
      transport: 'stdio',
      enabled: 1,
      registryId: 'claude-acp',
      installedVersion: '0.23.0',
      registryVersion: '0.24.2',
    })

    const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
    expect(result!.installedVersion).toBe('0.23.0')
    expect(result!.registryVersion).toBe('0.24.2')
    // Versions differ — this is how we detect "update available"
    expect(result!.installedVersion).not.toBe(result!.registryVersion)
  })
})
