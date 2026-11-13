/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractClientIp, getTrustedIpHeaders, withTrustedClientIp, type TrustedProxy } from './request'

describe('Utils - Request', () => {
  describe('extractClientIp', () => {
    describe('without trustedProxy (default)', () => {
      it('should return fallback when no trustedProxy is set, ignoring all headers', () => {
        const headers = new Headers({
          'x-forwarded-for': '203.0.113.42',
          'cf-connecting-ip': '198.51.100.1',
          'x-real-ip': '10.0.0.1',
        })
        expect(extractClientIp(headers, '172.16.0.1')).toBe('172.16.0.1')
      })

      it('should return default fallback when no headers present', () => {
        const headers = new Headers()
        expect(extractClientIp(headers)).toBe('unknown')
      })

      it('should return custom fallback when provided', () => {
        const headers = new Headers()
        expect(extractClientIp(headers, '127.0.0.1')).toBe('127.0.0.1')
      })

      it('should not use the Forwarded header (attacker-controlled)', () => {
        const headers = new Headers({ forwarded: 'for=attacker-ip' })
        expect(extractClientIp(headers)).toBe('unknown')
      })
    })

    describe('with trustedProxy=cloudflare', () => {
      it('should prefer CF-Connecting-IP over all other headers', () => {
        const headers = new Headers({
          'x-forwarded-for': '203.0.113.42',
          'cf-connecting-ip': '198.51.100.1',
          'x-real-ip': '10.0.0.1',
        })
        expect(extractClientIp(headers, 'unknown', 'cloudflare')).toBe('198.51.100.1')
      })

      it('should fall back to socket IP when CF header is absent, ignoring XFF', () => {
        const headers = new Headers({ 'x-forwarded-for': '203.0.113.42, 10.0.0.1, 172.16.0.1' })
        expect(extractClientIp(headers, 'socket-ip', 'cloudflare')).toBe('socket-ip')
      })

      it('should fall back to socket IP when CF header is absent, ignoring X-Real-IP', () => {
        const headers = new Headers({ 'x-real-ip': '10.0.0.5' })
        expect(extractClientIp(headers, 'socket-ip', 'cloudflare')).toBe('socket-ip')
      })

      it('should fall back to fallback when no headers present', () => {
        const headers = new Headers()
        expect(extractClientIp(headers, 'socket-ip', 'cloudflare')).toBe('socket-ip')
      })
    })

    describe('with trustedProxy=akamai', () => {
      it('should prefer True-Client-IP', () => {
        const headers = new Headers({ 'true-client-ip': '198.51.100.2' })
        expect(extractClientIp(headers, 'unknown', 'akamai')).toBe('198.51.100.2')
      })

      it('should fall back to socket IP when True-Client-IP is absent, ignoring XFF', () => {
        const headers = new Headers({ 'x-forwarded-for': '203.0.113.42' })
        expect(extractClientIp(headers, 'socket-ip', 'akamai')).toBe('socket-ip')
      })

      it('should not trust CF-Connecting-IP', () => {
        const headers = new Headers({ 'cf-connecting-ip': '198.51.100.1' })
        expect(extractClientIp(headers, 'socket-ip', 'akamai')).toBe('socket-ip')
      })
    })
  })
})

describe('fixed trusted proxy chains', () => {
  it('selects from the right and ignores forged leading and CDN headers', () => {
    const headers = new Headers({
      'x-forwarded-for': '192.0.2.99, 203.0.113.5, 10.0.0.4',
      'cf-connecting-ip': '192.0.2.66',
    })
    expect(extractClientIp(headers, 'socket', 1)).toBe('10.0.0.4')
    expect(extractClientIp(headers, 'socket', 2)).toBe('203.0.113.5')
    expect(extractClientIp(headers, 'socket')).toBe('socket')
  })

  it.each(['', '203.0.113.5,', '203.0.113.5, not-an-ip', '203.0.113.5, 999.1.2.3', '203.0.113.5:54321'])(
    'fails closed for a missing or malformed trusted hop: %s',
    (value) => expect(extractClientIp(new Headers({ 'x-forwarded-for': value }), 'socket', 1)).toBe('socket'),
  )

  it('does not shift past empty hops or a short chain into attacker-controlled input', () => {
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '203.0.113.5' }), 'socket', 2)).toBe('socket')
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '192.0.2.9, , 10.0.0.4' }), 'socket', 2)).toBe('socket')
  })

  // The embedded-IPv4 and zone-scoped forms are valid addresses that `new URL` cannot parse.
  it.each(['2001:0DB8:0:0:0:0:0:1', '2001:db8:1:2::192.0.2.33', '::ffff:203.0.113.5', 'fe80::1%eth0'])(
    'returns a valid trusted hop as the proxy wrote it, trimmed: %s',
    (address) => {
      expect(extractClientIp(new Headers({ 'x-forwarded-for': ` ${address} ` }), 'socket', 1)).toBe(address)
    },
  )
})

describe('trusted client IP for Better Auth', () => {
  const internalHeader = 'x-thunderbolt-client-ip'

  const headersByProxy: [TrustedProxy, string[] | undefined][] = [
    [1, [internalHeader]],
    ['cloudflare', ['cf-connecting-ip']],
    ['akamai', ['true-client-ip']],
    ['', undefined],
  ]
  it.each(headersByProxy)('reads the client from the header that matches TRUSTED_PROXY=%j', (trustedProxy, headers) => {
    expect(getTrustedIpHeaders(trustedProxy)).toEqual(headers)
  })

  it('replaces a forged internal header with the selected hop and keeps the rest of the request', async () => {
    const request = new Request('https://api.example.com/v1/api/auth/test', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '192.0.2.99, 203.0.113.5, 10.0.0.4',
        [internalHeader]: '192.0.2.66',
      },
      body: 'original body',
    })
    const normalized = withTrustedClientIp(request, 2)
    expect(normalized.headers.get(internalHeader)).toBe('203.0.113.5')
    expect(normalized.headers.get('x-forwarded-for')).toBe(request.headers.get('x-forwarded-for'))
    expect(normalized.method).toBe('POST')
    expect(normalized.url).toBe(request.url)
    expect(await normalized.text()).toBe('original body')
    expect(request.headers.get(internalHeader)).toBe('192.0.2.66')
  })

  it('replaces a forged internal header with "unknown" when no forwarded chain arrived', () => {
    const request = new Request('https://api.example.com', { headers: { [internalHeader]: '192.0.2.66' } })
    expect(withTrustedClientIp(request, 1).headers.get(internalHeader)).toBe('unknown')
  })

  it.each(['', 'cloudflare', 'akamai'] as const)(
    'leaves the request untouched for TRUSTED_PROXY=%j',
    (trustedProxy) => {
      const request = new Request('https://api.example.com', { headers: { [internalHeader]: '192.0.2.66' } })
      expect(withTrustedClientIp(request, trustedProxy)).toBe(request)
    },
  )
})
