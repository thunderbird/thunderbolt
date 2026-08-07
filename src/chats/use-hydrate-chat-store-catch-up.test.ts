/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The detached-turn catch-up predicate. Extracted from the hydrate hook because
 * all three of its inputs (thread, agent, transcript shape) are plain data —
 * driving them through the full hook would need PowerSync, MCP, and a router
 * to assert a boolean.
 *
 * Catch-up is keyed on the runner-owned marker: the built-in agent plus a
 * persisted `acpSessionId`. A local built-in thread never has one, so the same
 * agent identity means "catch up" or "nothing to catch up on" purely by whether
 * the thread was ever placed on the runner.
 */

import { builtInAgent } from '@/defaults/agents'
import { createMockChatThread } from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { describe, expect, it } from 'bun:test'
import { shouldCatchUpOnDetachedTurn } from './use-hydrate-chat-store'

const customAgent: Agent = {
  id: 'custom-1',
  name: 'My agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://elsewhere.test',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

const runnerOwnedThread = createMockChatThread({ acpSessionId: 'sess-stored' })

const userMessage: ThunderboltUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }
const partialAssistant: ThunderboltUIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'half' }],
  metadata: { partial: true },
}
const completeAssistant: ThunderboltUIMessage = {
  id: 'a2',
  role: 'assistant',
  parts: [{ type: 'text', text: 'all done' }],
}

describe('shouldCatchUpOnDetachedTurn', () => {
  it('catches up when a runner-owned thread ends on an unanswered user message', () => {
    expect(shouldCatchUpOnDetachedTurn(runnerOwnedThread, builtInAgent, [userMessage])).toBe(true)
  })

  it('catches up when a runner-owned thread ends on a crash-recovery partial', () => {
    expect(shouldCatchUpOnDetachedTurn(runnerOwnedThread, builtInAgent, [userMessage, partialAssistant])).toBe(true)
  })

  it('does not catch up on a completed transcript', () => {
    expect(shouldCatchUpOnDetachedTurn(runnerOwnedThread, builtInAgent, [userMessage, completeAssistant])).toBe(false)
  })

  it('does not catch up on an empty transcript', () => {
    expect(shouldCatchUpOnDetachedTurn(runnerOwnedThread, builtInAgent, [])).toBe(false)
  })

  it('does not catch up on a local built-in thread — it has no runner session', () => {
    const localThread = createMockChatThread({ acpSessionId: null })
    expect(shouldCatchUpOnDetachedTurn(localThread, builtInAgent, [userMessage])).toBe(false)
  })

  it('does not catch up for another agent’s session — that agent owns its own resume', () => {
    expect(shouldCatchUpOnDetachedTurn(runnerOwnedThread, customAgent, [userMessage])).toBe(false)
  })

  it('refuses to catch up on an encrypted thread, however it got marked', () => {
    const corrupted = createMockChatThread({ acpSessionId: 'sess-stored', isEncrypted: 1 })
    expect(shouldCatchUpOnDetachedTurn(corrupted, builtInAgent, [userMessage])).toBe(false)
  })

  it('does not catch up without a thread at all', () => {
    expect(shouldCatchUpOnDetachedTurn(null, builtInAgent, [userMessage])).toBe(false)
  })
})
