import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'
import { buildUserIdHash, extractClientIp } from './request'

describe('Utils - Request', () => {
  describe('buildUserIdHash', () => {
    it('should build user id from user-agent and client ip', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Test Browser)',
          'x-forwarded-for': '192.168.1.100',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe('Mozilla/5.0 (Test Browser):192.168.1.100')
    })

    it('should use x-real-ip if x-forwarded-for is not available', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Test Browser)',
          'x-real-ip': '10.0.0.5',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe('Mozilla/5.0 (Test Browser):10.0.0.5')
    })

    it('should use fallback when headers are missing', () => {
      const ctx: Partial<Context> = {
        headers: {},
      }

      const result = buildUserIdHash(ctx as Context, 'unknown-user')

      expect(result).toBe('unknown-user:unknown-user')
    })

    it('should use fallback for missing user-agent only', () => {
      const ctx: Partial<Context> = {
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe('fallback:192.168.1.100')
    })

    it('should use fallback for missing ip only', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Test Browser)',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe('Mozilla/5.0 (Test Browser):fallback')
    })

    it('should use default fallback when not provided', () => {
      const ctx: Partial<Context> = {
        headers: {},
      }

      const result = buildUserIdHash(ctx as Context)

      expect(result).toBe('unknown:unknown')
    })

    it('should prefer x-forwarded-for over x-real-ip', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Test Browser)',
          'x-forwarded-for': '192.168.1.100',
          'x-real-ip': '10.0.0.5',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe('Mozilla/5.0 (Test Browser):192.168.1.100')
    })

    it('should handle empty header values', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': '',
          'x-forwarded-for': '',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'empty-fallback')

      expect(result).toBe('empty-fallback:empty-fallback')
    })

    it('should handle complex user-agent strings', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'x-forwarded-for': '203.0.113.45, 198.51.100.67',
        },
      }

      const result = buildUserIdHash(ctx as Context, 'fallback')

      expect(result).toBe(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36:203.0.113.45, 198.51.100.67',
      )
    })

    it('should be stable for same inputs', () => {
      const ctx: Partial<Context> = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Test Browser)',
          'x-forwarded-for': '192.168.1.100',
        },
      }

      const result1 = buildUserIdHash(ctx as Context, 'fallback')
      const result2 = buildUserIdHash(ctx as Context, 'fallback')

      expect(result1).toBe(result2)
    })
  })

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

      it('should fall back to XFF rightmost when CF header is absent', () => {
        const headers = new Headers({ 'x-forwarded-for': 'spoofed, 10.0.0.1, 203.0.113.42' })
        expect(extractClientIp(headers, 'unknown', 'cloudflare')).toBe('203.0.113.42')
      })

      it('should trim whitespace from X-Forwarded-For', () => {
        const headers = new Headers({ 'x-forwarded-for': '10.0.0.1,  203.0.113.42 ' })
        expect(extractClientIp(headers, 'unknown', 'cloudflare')).toBe('203.0.113.42')
      })

      it('should fall back to X-Real-IP', () => {
        const headers = new Headers({ 'x-real-ip': '10.0.0.5' })
        expect(extractClientIp(headers, 'unknown', 'cloudflare')).toBe('10.0.0.5')
      })

      it('should fall back to fallback when no proxy headers present', () => {
        const headers = new Headers()
        expect(extractClientIp(headers, 'socket-ip', 'cloudflare')).toBe('socket-ip')
      })
    })

    describe('with trustedProxy=akamai', () => {
      it('should prefer True-Client-IP', () => {
        const headers = new Headers({ 'true-client-ip': '198.51.100.2' })
        expect(extractClientIp(headers, 'unknown', 'akamai')).toBe('198.51.100.2')
      })

      it('should fall back to XFF when True-Client-IP is absent', () => {
        const headers = new Headers({ 'x-forwarded-for': '203.0.113.42' })
        expect(extractClientIp(headers, 'unknown', 'akamai')).toBe('203.0.113.42')
      })

      it('should not trust CF-Connecting-IP', () => {
        const headers = new Headers({ 'cf-connecting-ip': '198.51.100.1' })
        expect(extractClientIp(headers, 'socket-ip', 'akamai')).toBe('socket-ip')
      })
    })
  })
})
