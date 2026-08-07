/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The synthetic runner wire target. It exists only so the ACP transport/auth
 * stack has an `Agent` to connect with — it is never a row, never a picker
 * entry, and its id must be impossible to confuse with a real agent's.
 */

import { builtInAgent } from '@/defaults/agents'
import { describe, expect, it } from 'bun:test'
import { buildRunnerWireTarget, isRunnerWireAgentId, runnerWireAgentId } from './runner-target'

describe('buildRunnerWireTarget', () => {
  const target = buildRunnerWireTarget('wss://runner.test/ws')

  it('is a managed ACP WebSocket target pointed at the configured runner', () => {
    expect(target).toMatchObject({
      id: runnerWireAgentId,
      type: 'managed-acp',
      transport: 'websocket',
      url: 'wss://runner.test/ws',
    })
  })

  it('carries a cache id that cannot collide with a real agent’s', () => {
    expect(target.id).not.toBe(builtInAgent.id)
    // A double-underscore sentinel: agent ids are uuids or discovered slugs.
    expect(target.id.startsWith('__')).toBe(true)
  })

  it('keeps the built-in agent’s product identity, so nothing user-visible changes', () => {
    expect(target.name).toBe(builtInAgent.name)
  })

  it('is a fresh object per call, so mutating one connection cannot affect another', () => {
    expect(buildRunnerWireTarget('wss://a.test')).not.toBe(buildRunnerWireTarget('wss://a.test'))
  })
})

describe('isRunnerWireAgentId', () => {
  it('recognizes the wire target and nothing else', () => {
    expect(isRunnerWireAgentId(runnerWireAgentId)).toBe(true)
    expect(isRunnerWireAgentId(builtInAgent.id)).toBe(false)
    expect(isRunnerWireAgentId('custom-1')).toBe(false)
  })
})
