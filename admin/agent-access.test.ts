/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { canMemberUseAgent } from './agent-access'
import { createCompanyAgent, createPreviewState } from './data'
import { previewReducer } from './use-admin-preview-state'

describe('agent grants from the source design', () => {
  it('distinguishes Everyone, Admin only, and an empty Restricted list', () => {
    const state = createPreviewState()
    const admin = state.members[0]
    const member = state.members[1]
    const agent = createCompanyAgent()
    expect(canMemberUseAgent(agent, admin, state)).toBe(false)
    expect(canMemberUseAgent(agent, member, state)).toBe(false)
    expect(canMemberUseAgent({ ...agent, accessMode: 'everyone' }, member, state)).toBe(true)
    expect(canMemberUseAgent({ ...agent, accessMode: 'admins' }, admin, state)).toBe(true)
    expect(canMemberUseAgent({ ...agent, accessMode: 'admins' }, member, state)).toBe(false)
  })
  it('resolves direct and group access without widening access when a group is deleted', () => {
    const state = createPreviewState()
    const member = state.members[1]
    const agent = state.agents[0]
    expect(canMemberUseAgent(agent, member, state)).toBe(true)
    const deleted = previewReducer(state, { type: 'remove', kind: 'groups', id: 'sales', at: 10 })
    expect(canMemberUseAgent(agent, member, deleted)).toBe(false)
    expect(canMemberUseAgent({ ...agent, memberIds: [member.id] }, member, deleted)).toBe(true)
    expect(canMemberUseAgent(agent, { ...member, deletedAt: 10 }, state)).toBe(false)
  })
  it('changing mode removes conflicting grants and returning to restricted does not grant everyone', () => {
    const state = createPreviewState()
    const restricted = state.agents[0]
    const admins = previewReducer(state, {
      type: 'agent-access',
      id: restricted.id,
      accessMode: 'admins',
      groupIds: restricted.groupIds,
      memberIds: ['jamie'],
    })
    expect(admins.agents[0].groupIds).toEqual([])
    expect(admins.agents[0].memberIds).toEqual([])
    const next = previewReducer(admins, {
      type: 'agent-access',
      id: restricted.id,
      accessMode: 'restricted',
      groupIds: [],
      memberIds: [],
    })
    expect(canMemberUseAgent(next.agents[0], next.members[1], next)).toBe(false)
  })
  it('keeps personal agents, built-in availability and personal models independent', () => {
    const state = createPreviewState()
    const next = previewReducer(state, { type: 'policy', patch: { thunderboltAllowed: false } })
    expect(next.policy).toEqual({ personalAgentsAllowed: true, thunderboltAllowed: false, personalModelsAllowed: true })
    expect(next.agents).toBe(state.agents)
  })
})
