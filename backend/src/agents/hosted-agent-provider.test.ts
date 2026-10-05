/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { createHostedAgentProvider } from './hosted-agent-provider'

const request = new Request('http://localhost/agents')

describe('createHostedAgentProvider', () => {
  it('emits nothing when the hosted agent is disabled', () => {
    const list = createHostedAgentProvider().list(request, createTestSettings({ agentEnabled: false }))
    expect(list).toEqual([])
  })

  it('emits one anonymous-safe managed-http descriptor when enabled', () => {
    const settings = createTestSettings({
      agentEnabled: true,
      agentName: 'Helper',
      agentDescription: 'Answers questions',
      agentIcon: 'sparkle',
    })
    expect(createHostedAgentProvider().list(request, settings)).toEqual([
      {
        id: 'hosted-agent',
        name: 'Helper',
        type: 'managed-http',
        transport: 'http',
        url: '/v1/agent/chat',
        description: 'Answers questions',
        icon: 'sparkle',
        isSystem: 1,
        anonymousSafe: true,
      },
    ])
  })

  it('falls back to a default name and null description/icon', () => {
    const [descriptor] = createHostedAgentProvider().list(request, createTestSettings({ agentEnabled: true }))
    expect(descriptor.name).toBe('Assistant')
    expect(descriptor.description).toBeNull()
    expect(descriptor.icon).toBeNull()
  })
})
