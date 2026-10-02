/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { loopbackOrigin } from './url'

describe('loopbackOrigin', () => {
  it('returns null when no override is set', () => {
    expect(loopbackOrigin(undefined)).toBeNull()
    expect(loopbackOrigin('')).toBeNull()
  })

  it('returns the origin of a loopback override', () => {
    expect(loopbackOrigin('http://localhost:9880')).toBe('http://localhost:9880')
    expect(loopbackOrigin('http://127.0.0.1:9880/some/path/')).toBe('http://127.0.0.1:9880')
    expect(loopbackOrigin('http://[::1]:9880')).toBe('http://[::1]:9880')
  })

  it('ignores any other host, including look-alikes', () => {
    expect(loopbackOrigin('https://evil.example')).toBeNull()
    expect(loopbackOrigin('http://localhost.evil.example')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1.evil.example')).toBeNull()
    expect(loopbackOrigin('http://user@evil.example')).toBeNull()
    expect(loopbackOrigin('not a url')).toBeNull()
  })
})
