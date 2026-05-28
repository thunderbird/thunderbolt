/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the Deepset SSE parser. The parser is a tiny piece of branching
 * logic but the consequences of getting it wrong are bad — a stuck or
 * silently-truncated stream looks identical to a working one until a user
 * notices missing text — so we cover the edge cases that have proven
 * load-bearing in other SSE adapters:
 *  - boundaries at the chunk seam,
 *  - mid-stream malformed JSON,
 *  - schema drift in the upstream wire,
 *  - the `result` payload → references/documents pipeline.
 */

import { describe, expect, it } from 'bun:test'
import { extractDocuments, extractReferences, HaystackSseParseError, parseHaystackSseStream } from './sse-parser'
import type { DeepsetResultPayload } from './types'

const encoder = new TextEncoder()

/** Helper that wraps a list of raw chunk strings into a `ReadableStream<Uint8Array>`. */
const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

const collect = async <T>(iter: AsyncIterableIterator<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const item of iter) {
    out.push(item)
  }
  return out
}

describe('parseHaystackSseStream', () => {
  it('parses a single Deepset delta envelope', async () => {
    const stream = streamFromChunks(['data: {"type":"delta","delta":{"text":"hi"}}\n\n'])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'hi' }])
  })

  it('parses multiple deltas + a final result in one chunk', async () => {
    const result = {
      answers: [
        {
          answer: 'final',
          files: [],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [{ id: 'd1', content: 'doc-content', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
    }
    const stream = streamFromChunks([
      'data: {"type":"delta","delta":{"text":"hello"}}\n\n' +
        'data: {"type":"delta","delta":{"text":" world"}}\n\n' +
        `data: ${JSON.stringify({ type: 'result', result })}\n\n` +
        'data: [DONE]\n\n',
    ])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([
      { type: 'delta', text: 'hello' },
      { type: 'delta', text: ' world' },
      { type: 'result', result },
      { type: 'done' },
    ])
  })

  it('reassembles an envelope split across chunk boundaries', async () => {
    const stream = streamFromChunks(['data: {"type":"delta","delta":{"te', 'xt":"split"}}\n\ndata: [DONE]\n\n'])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'split' }, { type: 'done' }])
  })

  it('ignores SSE comments and keep-alives between data frames', async () => {
    const stream = streamFromChunks([
      ': heartbeat\n\ndata: {"type":"delta","delta":{"text":"x"}}\n\n: another\n\ndata: [DONE]\n\n',
    ])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'x' }, { type: 'done' }])
  })

  it('silently drops envelopes with unknown types', async () => {
    // Forward compatibility: a future Deepset event shouldn't break the stream.
    const stream = streamFromChunks([
      'data: {"type":"future-shape","extra":1}\n\ndata: {"type":"delta","delta":{"text":"y"}}\n\n',
    ])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'y' }])
  })

  it('maps a Deepset error envelope to a normalized error event', async () => {
    const stream = streamFromChunks(['data: {"type":"error","message":"upstream boom"}\n\n'])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'error', error: 'upstream boom' }])
  })

  it('throws HaystackSseParseError with line context on malformed JSON', async () => {
    const stream = streamFromChunks(['data: not-json\n\n'])
    let caught: unknown
    try {
      await collect(parseHaystackSseStream(stream))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HaystackSseParseError)
    const err = caught as HaystackSseParseError
    expect(err.lineNumber).toBeGreaterThan(0)
    expect(err.message).toContain('malformed JSON')
    expect(err.raw).toBe('not-json')
  })

  it('throws HaystackSseParseError when a result payload fails schema validation', async () => {
    const stream = streamFromChunks(['data: {"type":"result","result":{"answers":"oops"}}\n\n'])
    let caught: unknown
    try {
      await collect(parseHaystackSseStream(stream))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HaystackSseParseError)
    const err = caught as HaystackSseParseError
    expect(err.message).toContain('result schema mismatch')
  })
})

describe('extractReferences / extractDocuments', () => {
  const result: DeepsetResultPayload = {
    answers: [
      {
        answer: 'a',
        files: [],
        meta: {
          _references: [
            { document_position: 1, document_id: 'doc-1' },
            { document_position: 2, document_id: 'doc-missing' },
          ],
        },
      },
    ],
    documents: [
      {
        id: 'doc-1',
        content: 'hello',
        score: 0.9,
        file: { id: 'file-1', name: 'a.pdf' },
        meta: { page_number: 7 },
      },
    ],
  }

  it('extracts references joined against documents and skips orphans', () => {
    expect(extractReferences(result)).toEqual([{ position: 1, fileId: 'file-1', fileName: 'a.pdf', pageNumber: 7 }])
  })

  it('extracts documents in source order', () => {
    expect(extractDocuments(result)).toEqual([
      { id: 'doc-1', content: 'hello', score: 0.9, file: { id: 'file-1', name: 'a.pdf' } },
    ])
  })

  it('returns an empty array when no references are present', () => {
    expect(extractReferences({ answers: [], documents: [] })).toEqual([])
  })
})
