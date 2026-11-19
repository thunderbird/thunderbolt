/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { installUrlCanParsePolyfill } from './polyfills'

describe('URL.canParse polyfill', () => {
  const descriptor = Object.getOwnPropertyDescriptor(URL, 'canParse')

  beforeEach(() => {
    Object.defineProperty(URL, 'canParse', { configurable: true, value: undefined })
  })

  afterEach(() => {
    if (descriptor) {
      Object.defineProperty(URL, 'canParse', descriptor)
    } else {
      Reflect.deleteProperty(URL, 'canParse')
    }
  })

  it.each([
    ['https://example.com/path', undefined, true],
    ['http://localhost:17421/?token=abc', undefined, true],
    ['mailto:support@example.com', undefined, true],
    ['not a URL', undefined, false],
    ['/redirect', undefined, false],
    ['/redirect', 'https://example.com/start', true],
    ['../redirect', 'https://example.com/start', true],
    ['//example.com/redirect', 'https://other.example/', true],
    ['/redirect', 'not a URL', false],
    ['https://example.com/', 'not a URL', false],
    ['https://', undefined, false],
    ['', 'https://example.com/', true],
  ] as const)('parses %s against %s as %s', (url, base, expected) => {
    installUrlCanParsePolyfill()
    expect(URL.canParse(url, base)).toBe(expected)
  })

  it('accepts URL objects', () => {
    installUrlCanParsePolyfill()
    expect(URL.canParse(new URL('https://example.com/'))).toBe(true)
  })

  it('preserves an existing implementation', () => {
    const nativeCanParse = (): boolean => true
    Object.defineProperty(URL, 'canParse', { configurable: true, value: nativeCanParse })
    installUrlCanParsePolyfill()
    expect(URL.canParse).toBe(nativeCanParse)
  })

  it('can be installed repeatedly', () => {
    installUrlCanParsePolyfill()
    const polyfill = URL.canParse
    installUrlCanParsePolyfill()
    expect(URL.canParse).toBe(polyfill)
  })
})
