/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { canManageAgent } from './agent-permissions'

const localAgent: Agent = {
  ...builtInAgent,
  id: 'local-agent',
  name: 'Local agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://agent.example/ws',
  isSystem: 0,
  userId: null,
}

describe('canManageAgent', () => {
  it.each([null, 'signed-in-user'])('allows a local agent before ownership is synced (user: %s)', (userId) => {
    expect(canManageAgent(localAgent, userId)).toBe(true)
  })

  it('allows a synced agent only for its owner', () => {
    const agent = { ...localAgent, userId: 'owner' }
    expect(canManageAgent(agent, 'owner')).toBe(true)
    expect(canManageAgent(agent, 'someone-else')).toBe(false)
    expect(canManageAgent(agent, null)).toBe(false)
  })

  it.each([null, 'signed-in-user'])('keeps built-in and deployment agents read-only (user: %s)', (userId) => {
    expect(canManageAgent(builtInAgent, userId)).toBe(false)
    expect(canManageAgent({ ...localAgent, isSystem: 1 }, userId)).toBe(false)
  })
})
