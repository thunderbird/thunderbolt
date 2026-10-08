/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { resolveSessionAgent } from './resolve-session-agent'

describe('resolveSessionAgent', () => {
  const agentWithId = (id: string): Agent => ({ ...builtInAgent, id, type: 'managed-acp' })
  const agents = [builtInAgent, agentWithId('thread'), agentWithId('discovered'), agentWithId('last-used')]

  it("keeps a persisted thread's own agent over the last-used and discovered agents", () => {
    const candidates = {
      threadAgentId: 'thread',
      lastUsedAgentId: 'last-used',
      discoveredDefaultAgent: agentWithId('discovered'),
    }
    expect(resolveSessionAgent(agents, candidates).id).toBe('thread')
  })

  it('prefers the last-used agent over the discovered default for a new chat', () => {
    const candidates = { lastUsedAgentId: 'last-used', discoveredDefaultAgent: agentWithId('discovered') }
    expect(resolveSessionAgent(agents, candidates).id).toBe('last-used')
  })

  it('falls back past ids that no longer resolve', () => {
    const candidates = {
      threadAgentId: 'deleted',
      lastUsedAgentId: 'gone',
      discoveredDefaultAgent: agentWithId('discovered'),
    }
    expect(resolveSessionAgent(agents, candidates).id).toBe('discovered')
    expect(resolveSessionAgent(agents, {}).id).toBe(builtInAgent.id)
    expect(resolveSessionAgent([], {})).toBe(builtInAgent)
  })
})
