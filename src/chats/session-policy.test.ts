/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus55 } from '@shared/defaults/models'
import { describe, expect, it } from 'bun:test'
import { builtInAgent, zeusAgent } from '@/defaults/agents'
import { createMockChatThread, createMockModel } from '@/test-utils/chat-store-mocks'
import { assertSessionCanSend } from './session-policy'

const tinfoil = createMockModel()
const opus = createMockModel({
  id: defaultModelOpus55.id,
  provider: 'thunderbolt',
  model: 'opus-5-5',
  isConfidential: 0,
})

describe('assertSessionCanSend', () => {
  it.each([builtInAgent, zeusAgent])('holds an unavailable agent instead of routing elsewhere ($name)', (agent) => {
    expect(() =>
      assertSessionCanSend({ chatThread: null, selectedAgent: { ...agent, enabled: 0 }, selectedModel: tinfoil }),
    ).toThrow('agent is unavailable')
  })

  it('rejects a changed owner even between two non-private agents', () => {
    expect(() =>
      assertSessionCanSend({
        chatThread: createMockChatThread({ agentId: 'original' }),
        selectedAgent: zeusAgent,
        selectedModel: opus,
      }),
    ).toThrow('Cannot change the agent')
  })

  it('holds a legacy private thread whose saved agent is non-private', () => {
    expect(() =>
      assertSessionCanSend({
        chatThread: createMockChatThread({ agentId: zeusAgent.id, isEncrypted: 1 }),
        selectedAgent: zeusAgent,
        selectedModel: opus,
      }),
    ).toThrow('private chat cannot run')
  })

  it.each([builtInAgent, zeusAgent])('rejects custom models for $name even with configured credentials', (agent) => {
    expect(() =>
      assertSessionCanSend({
        chatThread: null,
        selectedAgent: agent,
        selectedModel: createMockModel({ provider: 'custom', model: 'local-model', apiKey: 'configured-key' }),
      }),
    ).toThrow('model is not available')
  })

  it('allows each built-in only its configured model transport', () => {
    expect(() =>
      assertSessionCanSend({ chatThread: null, selectedAgent: builtInAgent, selectedModel: tinfoil }),
    ).not.toThrow()
    expect(() =>
      assertSessionCanSend({ chatThread: null, selectedAgent: zeusAgent, selectedModel: opus }),
    ).not.toThrow()
    expect(() =>
      assertSessionCanSend({
        chatThread: null,
        selectedAgent: builtInAgent,
        selectedModel: { ...opus, isConfidential: 1 },
      }),
    ).toThrow('model is not available')
    expect(() => assertSessionCanSend({ chatThread: null, selectedAgent: zeusAgent, selectedModel: tinfoil })).toThrow(
      'model is not available',
    )
  })
})
