import { describe, expect, test } from 'bun:test'
import type { Agent } from '@/types'
import { categorizeAgents } from './agent-selector'

const agentNullDefaults = {
  deletedAt: null,
  defaultHash: null,
  userId: null,
  description: null,
  registryId: null,
  installedVersion: null,
  registryVersion: null,
  distributionType: null,
  installPath: null,
  packageName: null,
} as const

const testAgents: Agent[] = [
  {
    id: 'agent-built-in',
    name: 'Thunderbolt',
    type: 'built-in',
    transport: 'in-process',
    icon: 'zap',
    isSystem: 1,
    enabled: 1,
    command: null,
    args: null,
    url: null,
    authMethod: null,
    ...agentNullDefaults,
  },
  {
    id: 'agent-claude-code',
    name: 'Claude Code',
    type: 'local',
    transport: 'stdio',
    icon: 'terminal',
    isSystem: 1,
    enabled: 1,
    command: 'claude',
    args: '["--acp"]',
    url: null,
    authMethod: null,
    ...agentNullDefaults,
  },
  {
    id: 'agent-haystack',
    name: 'Haystack Research',
    type: 'remote',
    transport: 'websocket',
    icon: 'globe',
    isSystem: 0,
    enabled: 1,
    command: null,
    args: null,
    url: 'wss://haystack.example.com/acp',
    authMethod: null,
    ...agentNullDefaults,
  },
]

describe('categorizeAgents', () => {
  test('groups agents by type', () => {
    const groups = categorizeAgents(testAgents)

    expect(groups).toHaveLength(3)
    expect(groups[0].id).toBe('built-in')
    expect(groups[0].items).toHaveLength(1)
    expect(groups[1].id).toBe('local')
    expect(groups[1].items).toHaveLength(1)
    expect(groups[2].id).toBe('remote')
    expect(groups[2].items).toHaveLength(1)
  })

  test('omits empty groups', () => {
    const builtInOnly = [testAgents[0]]
    const groups = categorizeAgents(builtInOnly)

    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('built-in')
  })

  test('assigns labels to local and remote groups', () => {
    const groups = categorizeAgents(testAgents)

    expect(groups[0].label).toBeUndefined() // built-in has no label (primary group)
    expect(groups[1].label).toBe('Local Agents')
    expect(groups[2].label).toBe('Remote Agents')
  })

  test('creates menu items with correct properties', () => {
    const groups = categorizeAgents(testAgents)
    const builtInItem = groups[0].items[0]

    expect(builtInItem.id).toBe('agent-built-in')
    expect(builtInItem.label).toBe('Thunderbolt')
    expect(builtInItem.description).toBe('Built-in')
    expect(builtInItem.disabled).toBe(false)
  })

  test('marks agents as disabled when in disabledAgentIds', () => {
    const disabledIds = new Set(['agent-claude-code', 'agent-haystack'])
    const groups = categorizeAgents(testAgents, disabledIds)

    // Built-in should NOT be disabled
    const builtInItem = groups[0].items[0]
    expect(builtInItem.disabled).toBe(false)

    // Local agent should be disabled
    const localItem = groups[1].items[0]
    expect(localItem.disabled).toBe(true)

    // Remote agent should be disabled
    const remoteItem = groups[2].items[0]
    expect(remoteItem.disabled).toBe(true)
  })

  test('does not disable agents when disabledAgentIds is empty', () => {
    const groups = categorizeAgents(testAgents, new Set())

    for (const group of groups) {
      for (const item of group.items) {
        expect(item.disabled).toBe(false)
      }
    }
  })

  test('does not disable agents when disabledAgentIds is undefined', () => {
    const groups = categorizeAgents(testAgents, undefined)

    for (const group of groups) {
      for (const item of group.items) {
        expect(item.disabled).toBe(false)
      }
    }
  })

  test('disabled agents show "Unavailable" in description', () => {
    const disabledIds = new Set(['agent-claude-code'])
    const groups = categorizeAgents(testAgents, disabledIds)

    const localItem = groups[1].items[0]
    expect(localItem.description).toBe('Unavailable')

    // Non-disabled agents keep their normal description
    const builtInItem = groups[0].items[0]
    expect(builtInItem.description).toBe('Built-in')
  })

  test('still groups disabled agents correctly by type', () => {
    const disabledIds = new Set(['agent-claude-code'])
    const groups = categorizeAgents(testAgents, disabledIds)

    expect(groups).toHaveLength(3)
    expect(groups[1].id).toBe('local')
    expect(groups[1].label).toBe('Local Agents')
    expect(groups[1].items).toHaveLength(1)
    expect(groups[1].items[0].id).toBe('agent-claude-code')
  })
})
