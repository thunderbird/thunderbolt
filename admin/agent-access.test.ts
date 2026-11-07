/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { canMemberUseAgent, getGroupAgentAccessSources, getMemberAgentAccessSources } from './agent-access'
import { createCompanyAgent, createPreviewState } from './data'
import { previewReducer } from './use-admin-preview-state'

describe('group-only agent grants', () => {
  it('grants nobody access until an agent is assigned to a group, including administrators', () => {
    const state = createPreviewState()
    const agent = createCompanyAgent()
    expect(canMemberUseAgent(agent, state.members[0], state)).toBe(false)
    expect(canMemberUseAgent(agent, state.members[1], state)).toBe(false)
    expect(canMemberUseAgent({ ...agent, groupIds: ['sales'] }, state.members[1], state)).toBe(true)
    expect(canMemberUseAgent({ ...agent, groupIds: ['sales'] }, state.members[0], state)).toBe(false)
  })

  it('revokes effective access when a group is deleted without changing the agent assignment', () => {
    const state = createPreviewState()
    const member = state.members[1]
    const agent = state.agents[0]
    expect(canMemberUseAgent(agent, member, state)).toBe(true)
    const deleted = previewReducer(state, { type: 'remove', kind: 'groups', id: 'sales', at: 10 })
    expect(canMemberUseAgent(agent, member, deleted)).toBe(false)
    expect(deleted.agents[0].groupIds).toEqual(['sales'])
    expect(canMemberUseAgent(agent, { ...member, deletedAt: 10 }, state)).toBe(false)
  })

  it('saves deduplicated group grants and an empty selection revokes all access', () => {
    const state = createPreviewState()
    const assigned = previewReducer(state, {
      type: 'agent-access',
      id: state.agents[0].id,
      groupIds: ['engineering', 'engineering', 'sales'],
    })
    expect(assigned.agents[0].groupIds).toEqual(['engineering', 'sales'])
    expect(state.agents[0].groupIds).toEqual(['sales'])
    expect(canMemberUseAgent(assigned.agents[0], assigned.members[0], assigned)).toBe(true)
    expect(canMemberUseAgent(assigned.agents[0], assigned.members[1], assigned)).toBe(true)
    const unassigned = previewReducer(assigned, {
      type: 'agent-access',
      id: state.agents[0].id,
      groupIds: [],
    })
    expect(canMemberUseAgent(unassigned.agents[0], unassigned.members[0], unassigned)).toBe(false)
    expect(canMemberUseAgent(unassigned.agents[0], unassigned.members[1], unassigned)).toBe(false)
  })

  it('keeps personal agents, built-in availability and personal models independent', () => {
    const state = createPreviewState()
    const next = previewReducer(state, { type: 'policy', patch: { thunderboltAllowed: false } })
    expect(next.policy).toEqual({ personalAgentsAllowed: true, thunderboltAllowed: false, personalModelsAllowed: true })
    expect(next.agents).toBe(state.agents)
  })
})

describe('agent access sources', () => {
  it('lists every matching assigned group', () => {
    const state = createPreviewState()
    const groups = state.groups.filter((group) => ['sales', 'finance'].includes(group.id))
    const member = { ...state.members[1], groupIds: groups.map((group) => group.id) }
    const agent = { ...state.agents[0], groupIds: member.groupIds }
    expect(getMemberAgentAccessSources(agent, member, state)).toEqual(
      groups.map((group) => ({ type: 'group' as const, group })),
    )
  })

  it('uses draft membership and omits deleted or missing groups', () => {
    const state = createPreviewState()
    const agent = { ...state.agents[0], groupIds: ['sales', 'finance', 'missing'] }
    const member = { ...state.members[1], groupIds: ['sales', 'finance', 'missing'] }
    const groups = state.groups.map((group) => (group.id === 'sales' ? { ...group, deletedAt: 10 } : group))
    const finance = state.groups[2]
    expect(getMemberAgentAccessSources(agent, member, { ...state, groups })).toEqual([
      { type: 'group', group: finance },
    ])
    expect(getMemberAgentAccessSources(agent, { ...member, groupIds: [] }, state)).toEqual([])
  })

  it('omits inactive agents and deleted members', () => {
    const state = createPreviewState()
    const member = state.members[1]
    const agent = state.agents[0]
    expect(getMemberAgentAccessSources({ ...agent, enabled: false }, member, state)).toEqual([])
    expect(getMemberAgentAccessSources({ ...agent, deletedAt: 10 }, member, state)).toEqual([])
    expect(getMemberAgentAccessSources(agent, { ...member, deletedAt: 10 }, state)).toEqual([])
  })

  it('returns an explicit group grant only when the assigned group and agent are live', () => {
    const state = createPreviewState()
    const group = state.groups[1]
    const agent = state.agents[0]
    expect(getGroupAgentAccessSources(agent, group)).toEqual([{ type: 'group', group }])
    expect(getGroupAgentAccessSources({ ...agent, groupIds: [] }, group)).toEqual([])
    expect(getGroupAgentAccessSources({ ...agent, groupIds: ['finance'] }, group)).toEqual([])
    expect(getGroupAgentAccessSources({ ...agent, enabled: false }, group)).toEqual([])
    expect(getGroupAgentAccessSources({ ...agent, deletedAt: 10 }, group)).toEqual([])
    expect(getGroupAgentAccessSources(agent, { ...group, deletedAt: 10 })).toEqual([])
  })
})
