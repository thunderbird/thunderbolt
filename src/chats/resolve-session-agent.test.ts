/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent, zeusAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { persistedThreadAgentId, resolveSessionAgent } from './resolve-session-agent'

const agentWithId = (id: string): Agent => ({ ...builtInAgent, id, type: 'managed-acp', isSystem: 1 })

describe('resolveSessionAgent', () => {
  const agents = [builtInAgent, agentWithId('thread'), agentWithId('discovered'), agentWithId('last-used')]
  // Deployments that disable the built-in (the MozFest setup) ship no built-in row.
  const agentsWithoutBuiltIn = [agentWithId('first-system'), agentWithId('discovered')]

  it("keeps a persisted thread's own agent over the last-used and discovered agents", () => {
    const candidates = {
      threadAgentId: 'thread',
      lastUsedAgentId: 'last-used',
      hasModelPick: true,
      discoveredDefaultAgent: agentWithId('discovered'),
    }
    expect(resolveSessionAgent(agents, candidates).id).toBe('thread')
  })

  it('prefers the last-used agent over the discovered default for a new chat', () => {
    const candidates = { lastUsedAgentId: 'last-used', discoveredDefaultAgent: agentWithId('discovered') }
    expect(resolveSessionAgent(agents, candidates).id).toBe('last-used')
  })

  it('treats a stored model pick as choosing the built-in agent over the discovered default', () => {
    const candidates = { hasModelPick: true, discoveredDefaultAgent: agentWithId('discovered') }
    expect(resolveSessionAgent(agents, candidates)).toBe(builtInAgent)
  })

  it('lets the discovered default win over a model pick when the deployment disables the built-in', () => {
    const candidates = { hasModelPick: true, discoveredDefaultAgent: agentWithId('discovered') }
    expect(resolveSessionAgent(agentsWithoutBuiltIn, candidates).id).toBe('discovered')
  })

  it('opens on the discovered default when the user has chosen nothing', () => {
    expect(resolveSessionAgent(agents, { discoveredDefaultAgent: agentWithId('discovered') }).id).toBe('discovered')
  })

  it('skips a discovered default that is not one of the available agents', () => {
    // An answer from another account or server, naming an agent this list doesn't have.
    const candidates = { discoveredDefaultAgent: agentWithId('other-server-agent') }
    expect(resolveSessionAgent(agentsWithoutBuiltIn, candidates).id).toBe('first-system')
  })

  it('keeps an unavailable saved agent instead of rerouting its history', () => {
    const candidates = { threadAgentId: 'deleted', lastUsedAgentId: 'gone' }
    expect(resolveSessionAgent(agentsWithoutBuiltIn, candidates)).toMatchObject({ id: 'deleted', enabled: 0 })
  })

  it('holds the chat when no agent is available', () => {
    expect(resolveSessionAgent([], { lastUsedAgentId: 'gone' })).toMatchObject({ id: builtInAgent.id, enabled: 0 })
  })
})

describe('persistedThreadAgentId', () => {
  it('maps legacy built-in chats by their established privacy, never the current preference', () => {
    for (const agentId of [null, builtInAgent.id]) {
      expect(persistedThreadAgentId({ agentId, isEncrypted: 1 })).toBe(builtInAgent.id)
      expect(persistedThreadAgentId({ agentId, isEncrypted: 0 })).toBe(zeusAgent.id)
    }
  })
  it('keeps explicit external and Zeus identities', () => {
    for (const agentId of ['external-agent', zeusAgent.id]) {
      expect(persistedThreadAgentId({ agentId, isEncrypted: 1 })).toBe(agentId)
    }
  })
})
