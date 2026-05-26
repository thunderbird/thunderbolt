/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the Haystack SSE parser. The parser is a tiny piece of branching
 * logic but the consequences of getting it wrong are bad — a stuck or
 * silently-truncated stream looks identical to a working one until a user
 * notices missing text — so we cover the edge cases that have proven
 * load-bearing in other SSE adapters:
 *  - boundaries at the chunk seam,
 *  - mid-stream malformed JSON,
 *  - schema drift in the upstream wire.
 */

import { describe, expect, it } from 'bun:test'
import { HaystackSseParseError, parseHaystackSseStream } from '../sse-parser'

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
  it('parses a single event in a single chunk', async () => {
    const stream = streamFromChunks(['data: {"type":"delta","text":"hi"}\n\n'])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'hi' }])
  })

  it('parses multiple events delivered in one chunk', async () => {
    const stream = streamFromChunks([
      'data: {"type":"delta","text":"hello"}\n\ndata: {"type":"delta","text":" world"}\n\ndata: {"type":"done"}\n\n',
    ])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'hello' }, { type: 'delta', text: ' world' }, { type: 'done' }])
  })

  it('reassembles an event split across chunk boundaries', async () => {
    // The frame separator (\n\n) lands in the second chunk; the parser must
    // hold the partial buffer until it can flush.
    const stream = streamFromChunks(['data: {"type":"delta","te', 'xt":"split"}\n\ndata: {"type":"done"}\n\n'])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([{ type: 'delta', text: 'split' }, { type: 'done' }])
  })

  it('ignores SSE comments and keep-alives between data frames', async () => {
    const stream = streamFromChunks([
      ': heartbeat\n\ndata: {"type":"delta","text":"x"}\n\n: another comment\n\ndata: {"type":"done","stopReason":"end_turn"}\n\n',
    ])
    const events = await collect(parseHaystackSseStream(stream))
    expect(events).toEqual([
      { type: 'delta', text: 'x' },
      { type: 'done', stopReason: 'end_turn' },
    ])
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
    expect(err.message).toContain('line ')
    expect(err.raw).toBe('not-json')
  })

  it('throws HaystackSseParseError with field detail on schema mismatch', async () => {
    // Unknown discriminator value — Zod surfaces a clear issue path.
    const stream = streamFromChunks(['data: {"type":"unknown","payload":1}\n\n'])
    let caught: unknown
    try {
      await collect(parseHaystackSseStream(stream))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HaystackSseParseError)
    const err = caught as HaystackSseParseError
    expect(err.message).toContain('schema mismatch')
    // The Zod discriminator error mentions the path `type` or `<root>`.
    expect(err.message.toLowerCase()).toMatch(/type|invalid/)
  })
})
