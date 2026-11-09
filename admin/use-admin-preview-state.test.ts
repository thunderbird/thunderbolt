/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { createPreviewState } from './data'
import { createAdminStore, previewReducer } from './use-admin-preview-state'

describe('admin preview state', () => {
  it('shares membership across views without duplicates or mutating the original fixture', () => {
    const original = createPreviewState()
    const action = { type: 'membership', memberId: 'jamie', groupId: 'engineering', enabled: true } as const
    const once = previewReducer(original, action)
    const twice = previewReducer(once, action)
    expect(twice.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales', 'engineering'])
    expect(original.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales'])
  })
  it('saves a group and its membership atomically without changing unrelated or removed memberships', () => {
    const fixture = createPreviewState()
    const original = {
      ...fixture,
      members: fixture.members.map((member) =>
        member.id === 'sam' ? { ...member, groupIds: ['finance', 'engineering'], deletedAt: 12 } : member,
      ),
    }
    const next = previewReducer(original, {
      type: 'save-group',
      group: { id: 'engineering', name: 'Platform engineering', deletedAt: null },
      memberIds: ['avery', 'jamie', 'jamie'],
    })
    expect(next.groups.find((group) => group.id === 'engineering')?.name).toBe('Platform engineering')
    expect(next.members.find((member) => member.id === 'avery')?.groupIds).toEqual(['engineering'])
    expect(next.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales', 'engineering'])
    expect(next.members.find((member) => member.id === 'taylor')?.groupIds).toEqual([])
    expect(next.members.find((member) => member.id === 'sam')).toEqual(
      original.members.find((member) => member.id === 'sam'),
    )
    expect(original.groups.find((group) => group.id === 'engineering')?.name).toBe('Engineering')
    expect(original.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales'])
    expect(original.members.find((member) => member.id === 'taylor')?.groupIds).toEqual(['engineering'])
  })
  it('assigns initial members when creating a group and accepts an empty selection on a later save', () => {
    const original = createPreviewState()
    const group = { id: 'platform', name: 'Platform', deletedAt: null }
    const created = previewReducer(original, { type: 'save-group', group, memberIds: ['jamie', 'avery'] })
    expect(created.groups.at(-1)).toEqual(group)
    expect(created.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales', 'platform'])
    expect(created.members.find((member) => member.id === 'avery')?.groupIds).toEqual(['engineering', 'platform'])
    const emptied = previewReducer(created, { type: 'save-group', group, memberIds: [] })
    expect(emptied.members.find((member) => member.id === 'jamie')?.groupIds).toEqual(['sales'])
    expect(emptied.members.find((member) => member.id === 'avery')?.groupIds).toEqual(['engineering'])
  })
  it('keeps membership untouched when a group save does not include a membership selection', () => {
    const original = createPreviewState()
    const renamed = previewReducer(original, {
      type: 'save-group',
      group: { id: 'engineering', name: 'Engineering team', deletedAt: null },
    })
    expect(renamed.members).toBe(original.members)
  })
  it('soft deletes groups without changing existing agent grants', () => {
    const next = previewReducer(createPreviewState(), { type: 'remove', kind: 'groups', id: 'sales', at: 42 })
    expect(next.groups.find((group) => group.id === 'sales')?.deletedAt).toBe(42)
    expect(next.agents.find((agent) => agent.id === 'demo-sales-agent')?.groupIds).toEqual(['sales'])
  })
  it('keeps sample edits isolated and reset restores all screens', () => {
    const original = createPreviewState()
    const edited = previewReducer(original, { type: 'policy', patch: { personalModelsAllowed: false } })
    expect(edited.policy.personalModelsAllowed).toBe(false)
    expect(original.policy.personalModelsAllowed).toBe(true)
    expect(previewReducer(edited, { type: 'reset' })).toEqual(original)
  })
})

describe('local admin persistence', () => {
  it('restores saved changes across remounts and keeps reset persistent', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
    const first = createAdminStore(storage)
    first.getState().dispatch({ type: 'membership', memberId: 'jamie', groupId: 'engineering', enabled: true })
    first.getState().dispatch({
      type: 'save-mcp-server',
      server: {
        id: 'review-server',
        name: 'Review server',
        url: 'https://example.com/mcp',
        transport: 'sse',
        enabled: 0,
        deletedAt: null,
      },
    })
    first.getState().dispatch({
      type: 'save-skill',
      skill: { ...createPreviewState().companySkills[0], instruction: 'Saved instructions' },
    })
    first.getState().dispatch({
      type: 'save-model',
      model: {
        id: 'company-model',
        name: 'Team model',
        provider: 'custom',
        model: 'local-model',
        url: 'http://localhost:11434/v1',
        enabled: 0,
        deletedAt: null,
      },
    })
    const restored = createAdminStore(storage)
    expect(restored.getState().state.companyModels[0]).toMatchObject({ model: 'local-model', enabled: 0 })
    restored.getState().dispatch({ type: 'remove', kind: 'companyModels', id: 'company-model', at: 100 })
    expect(createAdminStore(storage).getState().state.companyModels[0].deletedAt).toBe(100)
    expect(restored.getState().state.companyMcpServers[0]).toMatchObject({ transport: 'sse', enabled: 0 })
    expect(restored.getState().state.companySkills[0].instruction).toBe('Saved instructions')
    restored.getState().dispatch({ type: 'remove', kind: 'companyMcpServers', id: 'review-server', at: 99 })
    expect(createAdminStore(storage).getState().state.companyMcpServers[0].deletedAt).toBe(99)
    expect(restored.getState().state.members.find((member) => member.id === 'jamie')?.groupIds).toContain('engineering')
    restored.getState().dispatch({ type: 'reset' })
    expect(createAdminStore(storage).getState().state).toEqual(createPreviewState())
  })
})
