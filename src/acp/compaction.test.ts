/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  ClientSideConnection,
  type AnyMessage,
  type ContentBlock,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { acpCompactionKey, applyAcpCompactionUpdate, type AcpCompaction } from './compaction'

const snapshot: AcpCompaction = {
  agentId: 'agent',
  sessionId: 'session',
  compactionId: 'compact',
  status: 'in_progress',
  summary: [{ type: 'text', text: 'Initial' }],
  error: 'Previous error',
  _meta: { old: true },
}

describe('ACP compaction protocol patches', () => {
  it('accepts native compaction variants through the installed SDK wire parser', async () => {
    const updates: SessionNotification[] = [
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'compaction_update',
          compactionId: 'c',
          status: 'agent_custom_status',
          summary: null,
          error: null,
          _meta: null,
        },
      },
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: 'c',
          content: { type: 'text', text: 'Summary' },
          _meta: { chunk: true },
        },
      },
      { sessionId: 'session', update: { sessionUpdate: 'usage_update', used: 12, size: 100 } },
    ]
    const seen: SessionNotification[] = []
    const received = Promise.withResolvers<void>()
    const input = new TransformStream<AnyMessage, AnyMessage>()
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (params) => {
          seen.push(params)
          if (seen.length === updates.length) {
            received.resolve()
          }
        },
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      { readable: input.readable, writable: new WritableStream() },
    )
    const writer = input.writable.getWriter()
    for (const params of updates) {
      await writer.write({ jsonrpc: '2.0', method: 'session/update', params })
    }
    await received.promise
    await writer.close()
    await connection.closed
    expect(seen).toEqual(updates)
  })

  it('retains omitted fields and preserves unknown statuses', () => {
    expect(
      applyAcpCompactionUpdate(
        'agent',
        'session',
        {
          sessionUpdate: 'compaction_update',
          compactionId: 'compact',
          status: 'queued_by_agent',
        },
        snapshot,
      ),
    ).toEqual({ ...snapshot, status: 'queued_by_agent' })
  })

  it('replaces supplied fields without merging metadata and leaves the previous snapshot intact', () => {
    const next = applyAcpCompactionUpdate(
      'agent',
      'session',
      {
        sessionUpdate: 'compaction_update',
        compactionId: 'compact',
        status: 'failed',
        summary: [{ type: 'text', text: 'Replacement' }],
        error: 'New error',
        _meta: { next: true },
      },
      snapshot,
    )
    expect(next).toEqual({
      ...snapshot,
      status: 'failed',
      summary: [{ type: 'text', text: 'Replacement' }],
      error: 'New error',
      _meta: { next: true },
    })
    expect(snapshot.summary).toEqual([{ type: 'text', text: 'Initial' }])
    expect(snapshot._meta).toEqual({ old: true })
  })

  it.each([{ summary: null }, { summary: [] as ContentBlock[] }])(
    'clears a summary with %p and appends the next block to the empty summary',
    ({ summary }) => {
      const cleared = applyAcpCompactionUpdate(
        'agent',
        'session',
        {
          sessionUpdate: 'compaction_update',
          compactionId: 'compact',
          status: 'cancelled',
          summary,
          error: null,
          _meta: null,
        },
        snapshot,
      )
      expect(cleared).toEqual({ ...snapshot, status: 'cancelled', summary, error: null, _meta: null })
      const appended = applyAcpCompactionUpdate(
        'agent',
        'session',
        {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: 'compact',
          content: { type: 'text', text: 'Next' },
          _meta: { chunkOnly: true },
        },
        cleared,
      )
      expect(appended).toEqual({ ...cleared, summary: [{ type: 'text', text: 'Next' }] })
    },
  )

  it('creates first-seen chunks in progress and appends all block types in receive order', () => {
    const first = applyAcpCompactionUpdate('agent', 'session', {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'compact',
      content: { type: 'text', text: 'First' },
    })
    expect(first).toEqual({
      agentId: 'agent',
      sessionId: 'session',
      compactionId: 'compact',
      status: 'in_progress',
      summary: [{ type: 'text', text: 'First' }],
    })
    const resource = { type: 'resource_link' as const, uri: 'file:///plan', name: 'plan' }
    const next = applyAcpCompactionUpdate(
      'agent',
      'session',
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'compact',
        content: resource,
      },
      first,
    )
    expect(next.summary).toEqual([...first.summary!, resource])
    expect(first.summary).toHaveLength(1)
  })

  it('creates first-seen status updates without inventing optional fields', () => {
    expect(
      applyAcpCompactionUpdate('agent', 'session', {
        sessionUpdate: 'compaction_update',
        compactionId: 'compact',
        status: 'completed',
      }),
    ).toEqual({ agentId: 'agent', sessionId: 'session', compactionId: 'compact', status: 'completed' })
  })

  it('scopes opaque IDs across agents and sessions without delimiter collisions', () => {
    const keys = [
      snapshot,
      { ...snapshot, agentId: 'other' },
      { ...snapshot, sessionId: 'other' },
      { ...snapshot, sessionId: 'a:b', compactionId: 'c' },
      { ...snapshot, sessionId: 'a', compactionId: 'b:c' },
    ].map(acpCompactionKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
