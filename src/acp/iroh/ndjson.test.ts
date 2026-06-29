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
})
