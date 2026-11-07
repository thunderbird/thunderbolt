/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractClientIp, getTrustedIpHeaders, withTrustedClientIp } from './request'

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

  it.each(['', '203.0.113.5,', '203.0.113.5, not-an-ip', '203.0.113.5, 999.1.2.3', 'fe80::1%eth0'])(
    'fails closed for a missing or malformed trusted hop: %s',
    (value) => expect(extractClientIp(new Headers({ 'x-forwarded-for': value }), 'socket', 1)).toBe('socket'),
  )

  it('does not shift past empty hops or a short chain into attacker-controlled input', () => {
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '203.0.113.5' }), 'socket', 2)).toBe('socket')
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '192.0.2.9, , 10.0.0.4' }), 'socket', 2)).toBe('socket')
  })

  it('canonicalizes IPv6 and trims whitespace', () => {
    expect(extractClientIp(new Headers({ 'x-forwarded-for': ' 2001:0DB8:0:0:0:0:0:1 ' }), 'socket', 1)).toBe(
      '2001:db8::1',
    )
  })

  it('gives Better Auth the selected IP without trusting an incoming internal header', async () => {
    const request = new Request('https://api.example.com/v1/api/auth/test', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '192.0.2.99, 203.0.113.5, 10.0.0.4',
        'x-thunderbolt-client-ip': '192.0.2.66',
      },
      body: 'original body',
    })
    const normalized = withTrustedClientIp(request, 2)
    const [header] = getTrustedIpHeaders(2)!
    expect(normalized.headers.get(header)).toBe('203.0.113.5')
    expect(normalized.headers.get('x-forwarded-for')).toBe(request.headers.get('x-forwarded-for'))
    expect(normalized.method).toBe('POST')
    expect(normalized.url).toBe(request.url)
    expect(await normalized.text()).toBe('original body')
    expect(request.headers.get(header)).toBe('192.0.2.66')
  })

  it('overwrites a forged internal header even when XFF is missing', () => {
    const request = new Request('https://api.example.com', { headers: { 'x-thunderbolt-client-ip': '192.0.2.66' } })
    expect(withTrustedClientIp(request, 1).headers.get(getTrustedIpHeaders(1)![0])).toBe('unknown')
    expect(withTrustedClientIp(request, '')).toBe(request)
    expect(withTrustedClientIp(request, 'cloudflare')).toBe(request)
    expect(getTrustedIpHeaders('cloudflare')).toEqual(['cf-connecting-ip'])
    expect(getTrustedIpHeaders('akamai')).toEqual(['true-client-ip'])
    expect(getTrustedIpHeaders('')).toBeUndefined()
  })
})
