/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { projectEntry } from './runtime-state'

const entry = (toolName: string, text: string, isError = false): EntryRecord => ({
  id: 2 as EntryRecord['id'],
  conversationId: 1 as EntryRecord['conversationId'],
  kind: 'pi.tool-result',
  model: [
    { role: 'toolResult', toolCallId: 'call-1', toolName, content: [{ type: 'text', text }], isError, timestamp: 1 },
  ],
})

describe('cloud runtime message projection', () => {
  it('links compact artifact tool results without exposing key envelopes', () => {
    const artifactId = crypto.randomUUID()
    const result = JSON.stringify({ artifactId, revisionId: crypto.randomUUID(), title: 'Notes', conflict: false })
    for (const tool of ['create_artifact', 'update_artifact', 'read_artifact']) {
      expect(projectEntry(entry(tool, result))[0]!.content.artifactIds).toEqual([artifactId])
    }
  })

  it('preserves real call identities, mixed prose, and empty failed tool results', () => {
    const projected = projectEntry({
      id: 3 as EntryRecord['id'],
      conversationId: 1 as EntryRecord['conversationId'],
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'openai',
          model: 'test',
          timestamp: 1,
          stopReason: 'toolUse',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'toolCall', id: 'call-a', name: 'lookup', arguments: { record: 'a' } },
            { type: 'toolCall', id: 'call-b', name: 'lookup', arguments: { record: 'b' } },
          ],
        },
      ],
    })
    expect(projected[0]!.content).toEqual({
      role: 'assistant',
      text: 'Checking.',
      toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { record: 'a' } },
        { id: 'call-b', name: 'lookup', arguments: { record: 'b' } },
      ],
    })
    expect(projectEntry(entry('lookup', '', true))[0]!.content).toMatchObject({
      role: 'tool',
      text: '',
      toolName: 'lookup',
      toolCallId: 'call-1',
      toolError: true,
    })
  })

  it('does not turn arbitrary or failed tool JSON into artifact attachments', () => {
    const result = JSON.stringify({ artifactId: crypto.randomUUID() })
    expect(projectEntry(entry('external_tool', result))[0]!.content.artifactIds).toEqual([])
    expect(projectEntry(entry('create_artifact', result, true))[0]!.content.artifactIds).toBeUndefined()
    expect(projectEntry(entry('create_artifact', 'Malformed result'))[0]!.content.artifactIds).toEqual([])
  })
})
