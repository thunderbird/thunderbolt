/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractClientIp } from './request'

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
