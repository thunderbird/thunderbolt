/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it } from 'bun:test'
import type { Agent } from '@/types/acp'
import { isAgentAvailable } from './agent-availability'

const baseAgent: Agent = {
  id: 'a1',
  name: 'A1',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://x',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

describe('isAgentAvailable', () => {
  it('returns true for websocket agents on any platform', () => {
    expect(isAgentAvailable(baseAgent, { isTauri: () => false })).toBe(true)
    expect(isAgentAvailable(baseAgent, { isTauri: () => true })).toBe(true)
  })

  it('returns true for built-in agents even on in-process transport', () => {
    const builtIn: Agent = { ...baseAgent, type: 'built-in', transport: 'in-process', url: null }
    expect(isAgentAvailable(builtIn, { isTauri: () => false })).toBe(true)
  })

  it('returns false for non-built-in in-process agents in the web build', () => {
    const local: Agent = { ...baseAgent, type: 'remote-acp', transport: 'in-process' }
    expect(isAgentAvailable(local, { isTauri: () => false })).toBe(false)
  })

  it('returns true for non-built-in in-process agents on Tauri', () => {
    const local: Agent = { ...baseAgent, type: 'remote-acp', transport: 'in-process' }
    expect(isAgentAvailable(local, { isTauri: () => true })).toBe(true)
  })
})
