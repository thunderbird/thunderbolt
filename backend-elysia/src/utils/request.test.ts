import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'
import { buildUserIdHash } from './request'

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
})
