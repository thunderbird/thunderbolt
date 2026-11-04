/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent, isCloudAgent, isHostedAgent, isBuiltInAgent, isPortableAgent } from '@/defaults/agents'
import {
  cloudAgentResourceId,
  cloudAgentSelectionId,
  cloudAgentToAgent,
  cloudAgentsToInventory,
  agentInEnvironment,
  portableAgentResourceId,
} from './agent-inventory'
import { cloudAgentViewFixture } from './agent-inventory-fixture'

describe('cloud agent domain inventory', () => {
  it('carries the saved emoji to either environment and restores the default when cleared', () => {
    const view = cloudAgentViewFixture()
    const agent = cloudAgentToAgent({ ...view, config: { ...view.config, icon: '📊' } })
    expect(agent.icon).toBe('📊')
    expect(agentInEnvironment(agent, 'local').icon).toBe('📊')
    expect(cloudAgentToAgent({ ...view, config: { ...view.config, icon: null } }).icon).toBe('cloud')
  })
  it('selects either runtime without duplicating or changing the saved definition', () => {
    const original = cloudAgentToAgent(cloudAgentViewFixture())
    const local = agentInEnvironment(original, 'local')
    expect(local.cloudAgentId).toBe(original.cloudAgentId)
    expect(local.userId).toBe(original.userId)
    expect(portableAgentResourceId(local.id)).toBe(original.cloudAgentId)
    expect(cloudAgentResourceId(local.id)).toBeNull()
    expect(isBuiltInAgent(local)).toBe(true)
    expect(isCloudAgent(local)).toBe(false)
    expect(isPortableAgent(local)).toBe(true)
    expect(agentInEnvironment(local, 'cloud').id).toBe(original.id)
    expect(original.executionEnvironment).toBeUndefined()
    expect(portableAgentResourceId('local:../../keys')).toBeNull()
  })
  it('carries only a namespaced summary and never agent configuration or key material', () => {
    const view = cloudAgentViewFixture()
    const summary = cloudAgentToAgent(view)
    expect(summary).toEqual({
      id: `cloud:${view.record.id}`,
      cloudAgentId: view.record.id,
      name: view.config.name,
      description: view.config.description,
      type: 'cloud',
      transport: 'http',
      url: null,
      icon: 'cloud',
      isSystem: 0,
      enabled: 1,
      userId: 'owner',
      deletedAt: null,
    })
    expect(JSON.stringify(summary).toLowerCase()).not.toContain('secret')
    expect(isCloudAgent(summary)).toBe(true)
    expect(isCloudAgent(builtInAgent)).toBe(false)
    expect(isHostedAgent(summary)).toBe(false)
  })
  it('filters another owner and tombstones while retaining disabled historical identities', () => {
    const own = cloudAgentViewFixture()
    const disabled = { ...own, record: { ...own.record, id: '00000000-0000-4000-8000-000000000002', enabled: false } }
    const deleted = { ...own, record: { ...own.record, id: 'deleted', deletedAt: '2026-10-23' } }
    const result = cloudAgentsToInventory([own, disabled, deleted, cloudAgentViewFixture('another-owner')], 'owner')
    expect(result).toHaveLength(2)
    expect(result.map((agent) => agent.enabled)).toEqual([1, 0])
    expect(cloudAgentsToInventory([own], 'owner', false)[0].enabled).toBe(0)
  })
  it('parses only explicit cloud UUID identifiers and leaves ACP identifiers alone', () => {
    const id = cloudAgentViewFixture().record.id
    expect(cloudAgentResourceId(cloudAgentSelectionId(id))).toBe(id)
    for (const value of [
      null,
      undefined,
      '',
      id,
      'remote-agent',
      'cloud:../../identity',
      `cloud:${id}/messages`,
      'cloud:',
    ]) {
      expect(cloudAgentResourceId(value)).toBeNull()
    }
  })
})
