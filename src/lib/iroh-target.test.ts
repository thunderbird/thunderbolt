/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isIrohTarget } from './iroh-target'

describe('isIrohTarget', () => {
  it('matches a bare 52-char lowercase base32 NodeId', () => {
    expect(isIrohTarget('a'.repeat(52))).toBe(true)
  })

  it('matches a longer EndpointTicket (NodeId + relay + addrs)', () => {
    expect(isIrohTarget('node' + 'b'.repeat(120))).toBe(true)
  })

  it('rejects a base32 token shorter than a NodeId', () => {
    expect(isIrohTarget('abcdef234567')).toBe(false)
  })

  it('rejects an uppercased token (iroh emits lowercase base32)', () => {
    expect(isIrohTarget('A'.repeat(52))).toBe(false)
  })

  it('rejects out-of-alphabet base32 chars (0/1/8/9 excluded)', () => {
    expect(isIrohTarget('a'.repeat(51) + '0')).toBe(false)
    expect(isIrohTarget('a'.repeat(51) + '9')).toBe(false)
  })

  it('rejects URL-shaped inputs (they carry :/./ separators)', () => {
    expect(isIrohTarget('wss://example.com/ws')).toBe(false)
    expect(isIrohTarget('https://example.com/mcp')).toBe(false)
    expect(isIrohTarget('http://localhost:8000/mcp/')).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(isIrohTarget('')).toBe(false)
  })
})
