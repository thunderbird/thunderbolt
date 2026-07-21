/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { Agent } from '@/types/acp'
import { acpEndpointLabel, agentProvenanceLine } from './agent-provenance'

const customAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'My Agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.com/ws',
  description: null,
  icon: null,
  enabled: 1,
  isSystem: 0,
  userId: 'user-1',
  deletedAt: null,
  ...overrides,
})

describe('acpEndpointLabel', () => {
  it('returns the endpoint host for WebSocket agents', () => {
    expect(acpEndpointLabel({ transport: 'websocket', url: 'wss://example.com:8080/ws' })).toBe('example.com:8080')
  })

  it('returns a generic peer label for iroh targets', () => {
    expect(acpEndpointLabel({ transport: 'iroh', url: 'a'.repeat(52) })).toBe('iroh peer')
  })

  it('returns empty for a missing url', () => {
    expect(acpEndpointLabel({ transport: 'websocket', url: null })).toBe('')
  })

  it('falls back to the raw string when the url does not parse', () => {
    expect(acpEndpointLabel({ transport: 'websocket', url: 'not a url' })).toBe('not a url')
  })
})

describe('agentProvenanceLine', () => {
  it('labels the built-in agent', () => {
    expect(agentProvenanceLine(customAgent({ type: 'built-in' }))).toBe('Your agent · built into the app')
  })

  it('labels system agents', () => {
    expect(agentProvenanceLine(customAgent({ isSystem: 1 }))).toBe('System agent · always available')
  })

  it('labels custom agents with their endpoint host', () => {
    expect(agentProvenanceLine(customAgent())).toBe('Connected agent · example.com')
  })
})
