/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Settings } from '@/config/settings'
import { createCodingAgentProvider } from './provider'

const req = () => new Request('https://thunderbolt.example/v1/agents', { headers: { 'x-forwarded-proto': 'https' } })

// The provider only reads codingAgentWorkspaceWsUrl; a partial cast keeps the
// test free of full env/settings construction.
const settingsWith = (codingAgentWorkspaceWsUrl: string) => ({ codingAgentWorkspaceWsUrl }) as unknown as Settings

describe('createCodingAgentProvider', () => {
  it('advertises a single managed-acp websocket agent when the workspace endpoint is configured', () => {
    const provider = createCodingAgentProvider()
    const agents = provider.list(req(), settingsWith('wss://coding-agent.thunderbird.net/'))

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: 'coding-agent',
      name: 'Coding Agent',
      type: 'managed-acp',
      transport: 'websocket',
      isSystem: 1,
    })
    // URL points back at this backend's proxy route (wss derived from x-forwarded-proto).
    expect(agents[0].url).toBe('wss://thunderbolt.example/v1/coding-agent/ws')
  })

  it('advertises nothing when the workspace endpoint is unset', () => {
    const provider = createCodingAgentProvider()
    expect(provider.list(req(), settingsWith(''))).toEqual([])
    expect(provider.list(req(), settingsWith('   '))).toEqual([])
  })

  it('has a stable provider id', () => {
    expect(createCodingAgentProvider().id).toBe('coding-agent')
  })
})
