/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { collectProjectArtifacts, readArtifactPins } from './project-artifacts-data'

const labels = { untitledArtifact: 'Unbenannt', untitledChat: 'Neuer Chat' }
const messageId = '01a15fe6-ee73-770a-b8e0-8e5b4d55d747'
const part = (toolCallId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'tool-render_html',
  toolCallId,
  state: 'output-available',
  input: { title: 'Chart', html: '<h1>Chart</h1>' },
  output: { ok: true },
  ...overrides,
})
const collect = (parts: unknown) =>
  collectProjectArtifacts([{ id: messageId, chatThreadId: 'chat', chatTitle: 'Launch', parts }], labels)

describe('project artifacts', () => {
  it('excludes streaming, failed, empty, and missing-verdict artifacts', () => {
    expect(
      collect([
        part('stream', { state: 'input-available' }),
        part('failed', { output: { ok: false, errors: ['invalid'] } }),
        part('empty', { input: { html: ' ' } }),
        part('unknown', { output: {} }),
      ]),
    ).toEqual([])
  })
  it('retains distinct, stable links after failed retries with the same title', () => {
    const failed = part('retry', { output: { ok: false, errors: ['invalid'] } })
    const result = collect([failed, part('a'), part('b')])
    expect(result.map((artifact) => artifact.id)).toEqual([`${messageId}-1`, `${messageId}-2`])
    expect(collect([part('retry'), part('a'), part('b')])[1].id).toBe(result[0].id)
    expect(result[0]).toMatchObject({ toolCallId: 'a', html: '<h1>Chart</h1>', chatThreadId: 'chat' })
  })
  it('reads serialized MCP results as well as typed tool parts', () => {
    const result = collect(
      JSON.stringify([
        part('remote', {
          type: 'dynamic-tool',
          toolName: 'render_html',
          output: { content: [{ type: 'text', text: '{"ok":true}' }] },
        }),
      ]),
    )
    expect(result).toHaveLength(1)
    expect(result[0].toolCallId).toBe('remote')
  })
  it('tolerates malformed message JSON and non-part entries', () => {
    for (const parts of ['{broken', '{}', null, [null, false, {}, 'text']]) {
      expect(collect(parts)).toEqual([])
    }
  })
  it('uses localized fallbacks and excludes artifacts without source chats', () => {
    const parts = [part('a', { input: { title: ' ', html: '<p>Hello</p>' } })]
    const result = collectProjectArtifacts([{ id: messageId, chatThreadId: 'chat', chatTitle: null, parts }], labels)
    expect(result[0]).toMatchObject({ title: labels.untitledArtifact, chatTitle: labels.untitledChat })
    expect(collectProjectArtifacts([{ id: messageId, chatThreadId: null, chatTitle: null, parts }], labels)).toEqual([])
  })
})

describe('artifact pins', () => {
  const artifacts = [{ id: 'a' }, { id: 'b' }]
  it('preserves saved order and removes duplicate, deleted, or moved artifacts', () => {
    expect(readArtifactPins('["b","removed","a","b",42]', artifacts)).toEqual(['b', 'a'])
  })
  it('handles absent or invalid synced values', () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const value of [null, '', 'broken', '{}', 'null']) {
        expect(readArtifactPins(value, artifacts)).toEqual([])
      }
      expect(log).toHaveBeenCalledTimes(3)
    } finally {
      log.mockRestore()
    }
  })
})
