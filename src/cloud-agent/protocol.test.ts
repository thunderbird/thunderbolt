/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { isCloudRunActive, latestCloudProjection } from './protocol'
import type { CloudConversationState } from '@shared/cloud-agent/contracts'

const projection = (id: string, cursor: number): CloudConversationState => ({
  conversation: { id, agentId: 'agent', ownerId: 'owner', createdAt: '', updatedAt: '', deletedAt: null },
  runs: [],
  messages: [],
  approvals: [],
  cursor,
})

describe('cloud protocol', () => {
  test('does not replace a newer reconnect projection with a late response', () => {
    const previous = projection('a', 12)
    expect(latestCloudProjection(previous, projection('a', 11))).toBe(previous)
    expect(latestCloudProjection(previous, projection('a', 13)).cursor).toBe(13)
    expect(latestCloudProjection(previous, projection('b', 1)).conversation.id).toBe('b')
  })
  test('does not rewind a run status when no new transcript message was added', () => {
    const current = projection('a', 12)
    current.conversation.updatedAt = '2026-10-23T12:00:02Z'
    const delayed = projection('a', 12)
    delayed.conversation.updatedAt = '2026-10-23T12:00:01Z'
    expect(latestCloudProjection(current, delayed)).toBe(current)
  })
  test('does not restore a pending approval after its terminal decision', () => {
    const current = projection('a', 12)
    const approval = {
      id: 'approval',
      runId: 'run',
      agentId: 'agent',
      keyEpoch: 1,
      status: 'approved' as const,
      payload: { version: 1 as const, kind: 'scoped-payload' as const, iv: '', ciphertext: '' },
      createdAt: '',
    }
    current.approvals = [approval]
    const delayed = { ...current, approvals: [{ ...approval, status: 'pending' as const }] }
    expect(latestCloudProjection(current, delayed)).toBe(current)
  })
  test('a stop request is not a completed stop', () => {
    expect(isCloudRunActive('stop-requested')).toBe(true)
    for (const status of ['completed', 'stopped', 'failed', 'blocked', 'uncertain'] as const) {
      expect(isCloudRunActive(status)).toBe(false)
    }
  })
})
