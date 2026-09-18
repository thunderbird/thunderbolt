/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { isLoopbackHost } from './loopback.ts'

describe('isLoopbackHost', () => {
  test('accepts both IPv6 shapes its two callers supply', () => {
    // A URL.hostname brackets IPv6; a hand-written bind address does not.
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  test('accepts localhost and all of 127.0.0.0/8', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('127.255.255.255')).toBe(true)
  })

  test('rejects hosts that only look local', () => {
    // A prefix or substring test would pass these, and they resolve wherever
    // their owner points them.
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isLoopbackHost('notlocalhost')).toBe(false)
    expect(isLoopbackHost('1127.0.0.1')).toBe(false)
  })

  test('rejects the wildcard binds, which are the reason the check exists', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })
})
