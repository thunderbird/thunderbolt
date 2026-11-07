/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { expect, it } from 'bun:test'
import { createPreviewState } from './data'
import { canMemberUseAgent } from './agent-access'
import { createAdminStore } from './use-admin-preview-state'

it('replaces the invented catalog, preserves local edits, and rehydrates once into the original design', () => {
  const source = createPreviewState()
  const values = new Map([
    [
      'thunderbolt-admin-design',
      JSON.stringify({
        version: 1,
        state: {
          state: {
            members: source.members,
            groups: source.groups,
            agents: [
              {
                id: 'sales',
                name: 'Edited sales',
                description: 'Saved copy',
                enabled: true,
                groupIds: ['engineering'],
                memberIds: ['jamie'],
                accessMode: 'restricted',
                deletedAt: null,
              },
              {
                id: 'legacy-unassigned',
                name: 'Unassigned legacy agent',
                description: 'Saved legacy copy',
                enabled: true,
                groupIds: [],
                memberIds: ['jamie'],
                accessMode: 'everyone',
                deletedAt: null,
              },
            ],
            models: [{ id: 'standard', enabled: false }],
            mcp: [],
          },
        },
      }),
    ],
  ])
  const store = createAdminStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  })
  const state = store.getState().state
  expect(state.agents[0].name).toBe('Edited sales')
  expect(state.agents[0].groupIds).toEqual(['engineering'])
  expect(state.agents[0].acpUrl).toBe(source.agents[0].acpUrl)
  expect(state.agents[0].mcpKinds).toEqual(source.agents[0].mcpKinds)
  expect(state.agents.every((agent) => !('memberIds' in agent) && !('accessMode' in agent))).toBe(true)
  const unassigned = state.agents.find((agent) => agent.id === 'legacy-unassigned')
  expect(unassigned?.groupIds).toEqual([])
  expect(unassigned && canMemberUseAgent(unassigned, state.members[1], state)).toBe(false)
  expect(state).not.toHaveProperty('models')
  expect(state).not.toHaveProperty('mcp')
  expect(state.companySkills.map((skill) => skill.label)).toEqual(['Brand voice', 'Expense policy'])
  expect(JSON.parse(values.get('thunderbolt-admin-design') ?? '{}').version).toBe(5)
})

it('migrates version 2 metadata without losing edits or resurrecting removed skills', () => {
  const source = createPreviewState()
  const previous = {
    ...source,
    agents: source.agents.map((agent) => ({ ...agent, memberIds: ['jamie'], accessMode: 'restricted' })),
    companyMcpServers: undefined,
    companySkills: [
      { id: 'one', name: 'My policy', description: 'Saved description', deletedAt: null },
      { id: 'two', name: 'My policy', description: 'Removed description', deletedAt: 42 },
    ],
  }
  const values = new Map([['thunderbolt-admin-design', JSON.stringify({ version: 2, state: { state: previous } })]])
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const store = createAdminStore(storage)
  const state = store.getState().state
  expect(state.companySkills[0]).toMatchObject({
    id: 'one',
    label: 'My policy',
    description: 'Saved description',
    instruction: '',
    enabled: true,
  })
  expect(state.companySkills[1].deletedAt).toBe(42)
  expect(state.companySkills[0].name).not.toBe(state.companySkills[1].name)
  expect(state.companyMcpServers).toEqual([])
  expect(state.agents).toEqual(source.agents)
  expect(createAdminStore(storage).getState().state).toEqual(state)
})

it('adds model management without replacing version 3 skills, connections, or policy edits', () => {
  const previous = createPreviewState()
  const legacy = {
    ...previous,
    agents: previous.agents.map((agent) => ({ ...agent, memberIds: ['jamie'], accessMode: 'restricted' })),
    companyModels: undefined,
    policy: { ...previous.policy, personalModelsAllowed: false },
    companySkills: [{ ...previous.companySkills[0], instruction: 'Keep saved instructions' }],
    companyMcpServers: [
      {
        id: 'existing',
        name: 'Existing connection',
        url: 'https://example.com/mcp',
        transport: 'http' as const,
        enabled: 0,
        deletedAt: null,
      },
    ],
  }
  const values = new Map([['thunderbolt-admin-design', JSON.stringify({ version: 3, state: { state: legacy } })]])
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const state = createAdminStore(storage).getState().state
  expect(state).toEqual({ ...legacy, agents: previous.agents, companyModels: [] })
  expect(createAdminStore(storage).getState().state).toEqual(state)
})

it('migrates version 4 to group-only grants while preserving every other local edit and soft deletion', () => {
  const source = createPreviewState()
  const previous = {
    ...source,
    policy: { personalAgentsAllowed: false, thunderboltAllowed: false, personalModelsAllowed: false },
    members: source.members.map((member) => ({ ...member, name: `Edited ${member.name}` })),
    groups: source.groups.map((group) => ({ ...group, name: `Edited ${group.name}` })),
    companySkills: [{ ...source.companySkills[0], instruction: 'Retain saved instruction', deletedAt: 42 }],
    companyMcpServers: [
      {
        id: 'connection',
        name: 'Saved connection',
        url: 'https://example.com/mcp',
        transport: 'sse' as const,
        enabled: 0,
        deletedAt: 12,
      },
    ],
    companyModels: [
      {
        id: 'model',
        name: 'Saved model',
        provider: 'custom' as const,
        model: 'saved-model',
        url: 'http://localhost:11434/v1',
        enabled: 0,
        deletedAt: null,
      },
    ],
    agents: source.agents.slice(0, 5).map((agent, index) => ({
      ...agent,
      name: `Edited ${agent.name}`,
      groupIds: index === 0 ? ['engineering', 'sales'] : index === 4 ? ['finance'] : [],
      memberIds: ['jamie'],
      accessMode: index === 1 || index === 4 ? 'everyone' : index === 2 ? 'admins' : 'restricted',
      deletedAt: index === 3 ? 99 : null,
    })),
  }
  const values = new Map([['thunderbolt-admin-design', JSON.stringify({ version: 4, state: { state: previous } })]])
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const state = createAdminStore(storage).getState().state
  expect(state).toEqual({
    ...previous,
    agents: previous.agents.map(({ memberIds: _memberIds, accessMode: _accessMode, ...agent }) => agent),
  })
  expect(state.agents[0].groupIds).toEqual(['engineering', 'sales'])
  expect(canMemberUseAgent(state.agents[0], state.members[1], state)).toBe(true)
  expect(state.agents.slice(1, 4).every((agent) => agent.groupIds.length === 0)).toBe(true)
  expect(state.agents[4].groupIds).toEqual(['finance'])
  expect(canMemberUseAgent(state.agents[4], state.members[2], state)).toBe(true)
  expect(canMemberUseAgent(state.agents[4], state.members[1], state)).toBe(false)
  expect(canMemberUseAgent(state.agents[1], state.members[1], state)).toBe(false)
  expect(canMemberUseAgent(state.agents[2], state.members[0], state)).toBe(false)
  expect(canMemberUseAgent({ ...state.agents[3], deletedAt: null }, state.members[1], state)).toBe(false)
  expect(state.agents.every((agent) => !('memberIds' in agent) && !('accessMode' in agent))).toBe(true)
  expect(JSON.parse(values.get('thunderbolt-admin-design') ?? '{}').version).toBe(5)
  expect(createAdminStore(storage).getState().state).toEqual(state)
})
