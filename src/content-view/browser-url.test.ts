/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { normalizeBrowserUrl, resolveBrowserInput } from './browser-url'

describe('resolveBrowserInput', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    [' example.com/docs?q=hello#intro ', 'https://example.com/docs?q=hello#intro'],
    ['HTTPS://EXAMPLE.COM:443/docs', 'https://example.com/docs'],
    ['example.com:8443/docs', 'https://example.com:8443/docs'],
    ['localhost:3000/path', 'http://localhost:3000/path'],
    ['localhost', 'http://localhost/'],
    ['app.localhost:5173', 'http://app.localhost:5173/'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
    ['192.168.1.2', 'https://192.168.1.2/'],
    ['[::1]:5173', 'http://[::1]:5173/'],
    ['//example.com/path', 'https://example.com/path'],
    ['https://example.com/a b', 'https://example.com/a%20b'],
    ['例え.jp', 'https://xn--r8jz45g.jp/'],
  ])('resolves %s to a web address', (input, expected) => {
    expect(resolveBrowserInput(input)).toBe(expected)
  })

  it.each(['weather tomorrow', 'thunderbolt', 'C++ & Rust', 'person@example.com'])(
    'rejects non-address text %s',
    (query) => {
      expect(resolveBrowserInput(query)).toBeNull()
    },
  )

  it.each([
    '',
    '   ',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'mailto:user@example.com',
    'tauri://localhost',
    'https://',
    'java\nscript:alert(1)',
  ])('rejects %s', (input) => {
    expect(resolveBrowserInput(input)).toBeNull()
  })
})

describe('normalizeBrowserUrl', () => {
  it('normalizes equivalent addresses for bookmark matching', () => {
    expect(normalizeBrowserUrl('HTTPS://EXAMPLE.COM:443')).toBe('https://example.com/')
  })

  it.each(['example.com', 'javascript:alert(1)', 'file:///tmp/test', 'https://exa\nmple.com'])(
    'rejects %s',
    (input) => {
      expect(normalizeBrowserUrl(input)).toBeNull()
    },
  )
})
