/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isLocalUrl } from './is-local-url'

describe('isLocalUrl', () => {
  it.each([
    'http://localhost:1234/v1',
    'http://LOCALHOST/v1', // case-insensitive
    'http://host.docker.internal:1234/v1',
    'http://127.0.0.1:1234/v1',
    'http://127.255.255.255/',
    'http://10.0.0.1/v1',
    'http://192.168.1.42:1234/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.255/',
    'http://[::1]:1234/v1',
  ])('classifies %s as local', (url) => {
    expect(isLocalUrl(url)).toBe(true)
  })

  it.each([
    'https://api.openai.com/v1',
    'https://openrouter.ai/api/v1',
    'http://8.8.8.8/', // Google DNS — public
    'http://172.15.0.1/', // just below RFC1918
    'http://172.32.0.1/', // just above RFC1918
    'http://localhost.example.com/v1', // subdomain — must NOT match
    'http://evil-localhost/v1', // substring — must NOT match
    'http://example.com/localhost', // path segment — must NOT match
  ])('classifies %s as non-local', (url) => {
    expect(isLocalUrl(url)).toBe(false)
  })

  it('returns false for invalid URLs', () => {
    expect(isLocalUrl('not-a-url')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
  })
})
