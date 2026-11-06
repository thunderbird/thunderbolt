/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createNdjsonDecoder, encodeNdjsonFrame } from './ndjson'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('encodeNdjsonFrame', () => {
  it('serializes a message as a single newline-terminated JSON line', () => {
    const frame = encodeNdjsonFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(decode(frame)).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
  })
})

describe('createNdjsonDecoder', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

  it('decodes a single complete line', () => {
    const decoder = createNdjsonDecoder()
    expect(decoder.push(enc('{"a":1}\n'))).toEqual([{ a: 1 }])
  })

  it('decodes multiple messages in one chunk', () => {
    const decoder = createNdjsonDecoder()
    expect(decoder.push(enc('{"a":1}\n{"b":2}\n'))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('buffers a line split across chunks until its newline arrives', () => {
    const decoder = createNdjsonDecoder()
    expect(decoder.push(enc('{"a":'))).toEqual([])
    expect(decoder.push(enc('1}\n'))).toEqual([{ a: 1 }])
  })

  it('holds an unterminated trailing line and completes it on the next chunk', () => {
    const decoder = createNdjsonDecoder()
    expect(decoder.push(enc('{"a":1}\n{"b":'))).toEqual([{ a: 1 }])
    expect(decoder.push(enc('2}\n'))).toEqual([{ b: 2 }])
  })

  it('skips blank lines', () => {
    const decoder = createNdjsonDecoder()
    expect(decoder.push(enc('\n{"a":1}\n\n'))).toEqual([{ a: 1 }])
  })

  it('reassembles a multi-byte UTF-8 character split across chunks', () => {
    const decoder = createNdjsonDecoder()
    // '✅' is 3 bytes (0xE2 0x9C 0x85); split after the first byte.
    const full = enc('{"s":"✅"}\n')
    const splitAt = 7 // mid the multi-byte sequence
    expect(decoder.push(full.slice(0, splitAt))).toEqual([])
    expect(decoder.push(full.slice(splitAt))).toEqual([{ s: '✅' }])
  })

  it('fails loud instead of buffering an unbounded newline-less stream (no tab OOM)', () => {
    const decoder = createNdjsonDecoder()
    // A peer streaming bytes that never contain a newline must not grow the
    // pending-line buffer forever. Feed > 16MB across chunks with no '\n'.
    const chunk = enc('a'.repeat(4 * 1024 * 1024)) // 4MB, no newline
    expect(decoder.push(chunk)).toEqual([])
    expect(decoder.push(chunk)).toEqual([])
    expect(decoder.push(chunk)).toEqual([])
    expect(decoder.push(chunk)).toEqual([])
    expect(() => decoder.push(chunk)).toThrow('ndjson frame exceeded')
  })

  it('rejects a single oversized newline-terminated frame before parsing it', () => {
    const decoder = createNdjsonDecoder()
    // A completed frame larger than the cap must not reach JSON.parse (the
    // allocation alone can OOM the tab), even though it carries its own newline.
    const oversized = enc(`${'a'.repeat(17 * 1024 * 1024)}\n`)
    expect(() => decoder.push(oversized)).toThrow('ndjson frame exceeded')
  })

  it('still decodes normally after a long-but-bounded partial line', () => {
    const decoder = createNdjsonDecoder()
    const big = `{"big":"${'x'.repeat(1024 * 1024)}"}` // ~1MB, well under the cap
    expect(decoder.push(enc(big))).toEqual([]) // buffered, no newline yet
    expect(decoder.push(enc('\n'))).toEqual([{ big: 'x'.repeat(1024 * 1024) }])
  })
})
