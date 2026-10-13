/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { expect, it } from 'bun:test'
import { createPreviewState } from './data'
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
  expect(state).not.toHaveProperty('models')
  expect(state).not.toHaveProperty('mcp')
  expect(state.companySkills.map((skill) => skill.label)).toEqual(['Brand voice', 'Expense policy'])
  expect(JSON.parse(values.get('thunderbolt-admin-design') ?? '{}').version).toBe(4)
})

it('migrates version 2 metadata without losing edits or resurrecting removed skills', () => {
  const source = createPreviewState()
  const previous = {
    ...source,
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
  expect(state).toEqual({ ...legacy, companyModels: [] })
  expect(createAdminStore(storage).getState().state).toEqual(state)
})
