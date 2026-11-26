/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { acpCompactionKey, type AcpCompaction } from '@/acp/compaction'
import type { ThunderboltUIMessage } from '@/types'
import { applyAcpSessionEvent, getAcpCompactions } from './acp-session-events'

const compaction: AcpCompaction = {
  agentId: 'agent',
  sessionId: 'session',
  compactionId: 'compact-1',
  status: 'in_progress',
}
const reply: ThunderboltUIMessage = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] }

describe('ACP session presentation events', () => {
  it('creates one idle entity and replaces replayed updates in place without touching other content', () => {
    const first = applyAcpSessionEvent([reply], { type: 'compaction', compaction }, false)!
    expect(first.messages).toHaveLength(2)
    expect(first.messages[0]).toBe(reply)
    const completed: AcpCompaction = {
      ...compaction,
      status: 'completed',
      summary: [{ type: 'text', text: 'Summary' }],
    }
    const second = applyAcpSessionEvent(first.messages, { type: 'compaction', compaction: completed }, false)!
    expect(second.messages).toHaveLength(2)
    expect(second.changed.id).toBe(first.changed.id)
    expect(second.changed.parts).toEqual([
      { type: 'data-acp-compaction', id: acpCompactionKey(compaction), data: completed },
    ])
    expect(getAcpCompactions(second.messages)).toEqual([completed])
    expect(second.changed.metadata?.contextCompaction).toBeUndefined()
  })

  it('keeps reused opaque IDs distinct across agents and sessions', () => {
    const identities = [compaction, { ...compaction, agentId: 'other' }, { ...compaction, sessionId: 'other' }]
    const messages = identities.reduce<ThunderboltUIMessage[]>(
      (messages, item) => applyAcpSessionEvent(messages, { type: 'compaction', compaction: item }, false)!.messages,
      [],
    )
    expect(messages).toHaveLength(3)
    expect(new Set(messages.map((message) => message.id)).size).toBe(3)
    expect(getAcpCompactions(messages)).toEqual(identities)
  })

  it('lets the active stream own new and current entities while patching historical entities', () => {
    expect(applyAcpSessionEvent([reply], { type: 'compaction', compaction }, true)).toBeUndefined()
    const first = applyAcpSessionEvent([reply], { type: 'compaction', compaction }, false)!
    expect(applyAcpSessionEvent(first.messages, { type: 'compaction', compaction }, true)).toBeUndefined()
    const updates = [...first.messages, { ...reply, id: 'current' }]
    const failed = { ...compaction, status: 'failed', error: 'Cancelled remotely' }
    const next = applyAcpSessionEvent(updates, { type: 'compaction', compaction: failed }, true)!
    expect(next.messages.at(-1)).toBe(updates.at(-1))
    expect(getAcpCompactions(next.messages)).toEqual([failed])
  })

  it('saves idle context usage separately from billing and leaves active usage to the stream', () => {
    const usage = { agentId: 'agent', sessionId: 'session', used: 0, size: 2000 }
    const billing = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    const original: ThunderboltUIMessage = { ...reply, metadata: { usage: billing } }
    const next = applyAcpSessionEvent([original], { type: 'usage', usage }, false)!
    expect(next.changed.metadata).toEqual({ usage: billing, acpContextUsage: usage, contextTokens: 0 })
    expect(original.metadata?.acpContextUsage).toBeUndefined()
    expect(applyAcpSessionEvent([original], { type: 'usage', usage }, true)).toBeUndefined()
    expect(applyAcpSessionEvent([], { type: 'usage', usage }, false)).toBeUndefined()
  })
})
