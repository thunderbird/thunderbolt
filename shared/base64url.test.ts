/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { decodeBase64Url, encodeBase64Url } from './base64url'

const samples = ['', 'plain-ascii', 'aBcD1234ef.gh+IJ/klMNop==', 'wss://example.com/mcp?a=1&b=2', 'ümlaut, 日本語, 🦊']

describe('base64url', () => {
  it('matches the runtime base64url encoding', () => {
    for (const text of samples) {
      expect(encodeBase64Url(text)).toBe(Buffer.from(text, 'utf-8').toString('base64url'))
    }
  })

  it('decodes what it encodes', () => {
    for (const text of samples) {
      expect(decodeBase64Url(encodeBase64Url(text))).toBe(text)
    }
  })

  it('returns null for input that is not base64url', () => {
    expect(decodeBase64Url('!!!')).toBeNull()
    expect(decodeBase64Url('a')).toBeNull()
  })
})
