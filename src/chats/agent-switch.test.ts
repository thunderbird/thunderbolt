/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { cloudAgentToAgent, agentInEnvironment } from '@/cloud-agent/agent-inventory'
import { cloudAgentViewFixture } from '@/cloud-agent/agent-inventory-fixture'
import { agentSwitchNeedsNewChat, newChatForAgent, newChatSearchForAgent } from './agent-switch'

const cloud = cloudAgentToAgent(cloudAgentViewFixture())
const otherCloud = cloudAgentToAgent(cloudAgentViewFixture('owner', '00000000-0000-4000-8000-000000000002'))

describe('environment selection preserves durable chat ownership', () => {
  it('pins the environment for existing conversations with the same definition', () => {
    const local = agentInEnvironment(cloud, 'local')
    expect(agentSwitchNeedsNewChat(cloud, local, true)).toBe(true)
    expect(agentSwitchNeedsNewChat(local, cloud, true)).toBe(true)
    expect(agentSwitchNeedsNewChat(local, cloud, false)).toBe(false)
    expect(agentSwitchNeedsNewChat(local, local, true)).toBe(false)
  })
  it('updates a new-chat agent query without discarding its project or draft parameters', () => {
    const search = newChatSearchForAgent(
      '?agent=thunderbolt-built-in&projectId=project-a&draft=some+text&tag=a&tag=b',
      cloud,
    )
    const params = new URLSearchParams(search)
    expect(params.get('agent')).toBe(cloud.id)
    expect(params.get('projectId')).toBe('project-a')
    expect(params.get('draft')).toBe('some text')
    expect(params.getAll('tag')).toEqual(['a', 'b'])
  })

  it('starts a new chat when switching into, out of, or between cloud agents with history', () => {
    expect(agentSwitchNeedsNewChat(builtInAgent, cloud, true)).toBe(true)
    expect(agentSwitchNeedsNewChat(cloud, builtInAgent, true)).toBe(true)
    expect(agentSwitchNeedsNewChat(cloud, otherCloud, true)).toBe(true)
    expect(agentSwitchNeedsNewChat(cloud, cloud, true)).toBe(false)
  })
  it('allows selection before the first message without moving an empty draft', () => {
    expect(agentSwitchNeedsNewChat(builtInAgent, cloud, false)).toBe(false)
    expect(agentSwitchNeedsNewChat(cloud, otherCloud, false)).toBe(false)
  })
  it('preserves the exact cloud choice in the new chat route without mutating either agent', () => {
    const snapshot = structuredClone(cloud)
    const target = new URL(newChatForAgent(cloud), 'https://app.test')
    expect(target.pathname).toBe('/chats/new')
    expect(target.searchParams.get('agent')).toBe(cloud.id)
    expect(cloud).toEqual(snapshot)
  })
})
