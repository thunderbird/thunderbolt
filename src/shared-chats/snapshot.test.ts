/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { UIMessageMetadata } from '@/types'
import type { UIMessage } from 'ai'

import { buildShareSnapshot, parseShareSnapshot, type SnapshotSource } from './snapshot'

const artifactPart = (overrides: Record<string, unknown> = {}) => ({
  type: 'tool-render_html',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { html: '<p>hi</p>', title: 'Card' },
  output: { ok: true },
  providerMetadata: { secret: 'provider' },
  ...overrides,
})

const message = (overrides: Partial<SnapshotSource> = {}): SnapshotSource => ({
  id: 'm1',
  role: 'assistant',
  parts: [],
  cache: null,
  metadata: null,
  ...overrides,
})

describe('buildShareSnapshot', () => {
  it('keeps text, verified artifacts and attachment names, normalising each', () => {
    const snapshot = buildShareSnapshot('Trip ideas', [
      message({
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Plan a trip' },
          {
            type: 'data-attachment',
            data: { localFileId: 'local-123', filename: 'notes.pdf', mimeType: 'application/pdf', deliverAs: 'text' },
          },
        ] as UIMessage['parts'],
      }),
      message({ id: 'a1', parts: [{ type: 'text', text: 'Here you go' }, artifactPart()] as UIMessage['parts'] }),
    ])

    expect(snapshot).toEqual({
      version: 1,
      title: 'Trip ideas',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Plan a trip' },
            { type: 'data-attachment', data: { filename: 'notes.pdf', mimeType: 'application/pdf' } },
          ],
        },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Here you go' },
            {
              type: 'tool-render_html',
              toolCallId: 'call-1',
              state: 'output-available',
              input: { html: '<p>hi</p>', title: 'Card' },
              output: { ok: true },
            },
          ],
        },
      ],
    })
  })

  it('drops reasoning, other tool calls, failed or unfinished artifacts and empty text', () => {
    const snapshot = buildShareSnapshot('t', [
      message({
        parts: [
          { type: 'reasoning', text: 'thinking privately' },
          { type: 'tool-search_web', toolCallId: 't1', state: 'output-available', input: {}, output: 'secret' },
          {
            type: 'dynamic-tool',
            toolName: 'mcp_read',
            toolCallId: 't2',
            state: 'output-available',
            input: {},
            output: {},
          },
          artifactPart({ toolCallId: 'failed', output: { ok: false, errors: ['bad'] } }),
          artifactPart({ toolCallId: 'pending', state: 'input-available', output: undefined }),
          { type: 'text', text: '   ' },
          { type: 'data-quote', data: { text: 'quoted' } },
          { type: 'step-start' },
        ] as UIMessage['parts'],
      }),
    ])
    expect(snapshot.messages).toEqual([])
  })

  it('keeps the widget cache the viewer renders and citation metadata, and nothing else', () => {
    const metadata = {
      modelId: 'secret-model',
      usage: { inputTokens: 10 },
      mcpTools: { x: { name: 'Server', url: 'https://mcp.internal', toolName: 'x' } },
      debugTranscript: { id: 'dbg' },
      sources: [{ index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' }],
    } as unknown as UIMessageMetadata
    const snapshot = buildShareSnapshot('t', [
      message({
        parts: [{ type: 'text', text: 'Sunny <widget:weather-forecast location="Lisbon" />' }],
        cache: { 'weatherForecast/Lisbon': { temp: 21 }, connectIntegrationWidget: { isHidden: true } },
        metadata,
      }),
    ])

    expect(snapshot.messages[0].cache).toEqual({ 'weatherForecast/Lisbon': { temp: 21 } })
    expect(snapshot.messages[0].metadata).toEqual({
      sources: [{ index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' }],
      haystackReferences: undefined,
      haystackDocuments: undefined,
    })
  })

  it('drops system messages', () => {
    expect(buildShareSnapshot('t', [message({ role: 'system', parts: [{ type: 'text', text: 'You are' }] })])).toEqual({
      version: 1,
      title: 't',
      messages: [],
    })
  })
})

describe('parseShareSnapshot', () => {
  it('round-trips a built snapshot', () => {
    const snapshot = buildShareSnapshot('t', [
      message({ parts: [{ type: 'text', text: 'hello' }, artifactPart()] as UIMessage['parts'] }),
    ])
    expect(parseShareSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('puts a snapshot from another account back through the allowlist', () => {
    const parsed = parseShareSnapshot({
      version: 1,
      title: 't',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'ok' },
            { type: 'tool-exec', toolCallId: 'x', state: 'output-available' },
          ],
          metadata: { modelId: 'smuggled', sources: [] },
        },
      ],
    })
    expect(parsed.messages[0].parts).toEqual([{ type: 'text', text: 'ok' }])
    expect(parsed.messages[0].metadata).toEqual({
      sources: [],
      haystackReferences: undefined,
      haystackDocuments: undefined,
    })
  })

  it('drops parts and citation fields that are not shaped the way the viewer renders them', () => {
    const parsed = parseShareSnapshot({
      version: 1,
      title: 't',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'kept' },
            { type: 'text', text: { not: 'a string' } },
            { type: 'data-attachment', data: { filename: { not: 'a string' }, mimeType: 'text/plain' } },
            { type: 'data-attachment', data: { filename: 'notes.txt', mimeType: 'text/plain' } },
          ],
          metadata: {
            sources: [{ index: 1, url: 'https://example.com', title: { not: 'a string' }, toolName: 'search' }],
            haystackReferences: [{ position: 1, fileId: 'f', fileName: 'doc.pdf' }],
          },
        },
      ],
    })
    expect(parsed.messages[0].parts).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'data-attachment', data: { filename: 'notes.txt', mimeType: 'text/plain' } },
    ])
    expect(parsed.messages[0].metadata).toEqual({
      sources: undefined,
      haystackReferences: [{ position: 1, fileId: 'f', fileName: 'doc.pdf' }],
      haystackDocuments: undefined,
    })
  })

  it('passes widget cache values through whatever their shape, leaving them to each widget', () => {
    const cache = { 'linkPreview/a': null, 'weatherForecast/b': 'odd', 'ask/c': { chosen: [] } }
    const parsed = parseShareSnapshot({
      version: 1,
      title: 't',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], cache }],
    })
    expect(parsed.messages[0].cache).toEqual(cache)
  })

  it.each([
    ['an unknown version', { version: 2, title: 't', messages: [] }],
    ['a system message', { version: 1, title: 't', messages: [{ id: 'm', role: 'system', parts: [] }] }],
    ['a missing title', { version: 1, messages: [] }],
  ])('refuses %s', (_, value) => {
    expect(() => parseShareSnapshot(value)).toThrow()
  })
})
