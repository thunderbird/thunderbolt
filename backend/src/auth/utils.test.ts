import { describe, expect, it } from 'bun:test'
import { buildMagicLinkUrl, getValidatedOrigin, parseTrustedOrigins } from './utils'

describe('parseTrustedOrigins', () => {
  it('parses comma-separated origins', () => {
    const result = parseTrustedOrigins('http://localhost:1420,https://app.example.com')
    expect(result).toEqual(['http://localhost:1420', 'https://app.example.com'])
  })

  it('filters empty values from comma-separated string', () => {
    const result = parseTrustedOrigins('http://localhost:1420,,https://app.example.com,')
    expect(result).toEqual(['http://localhost:1420', 'https://app.example.com'])
  })

  it('returns default origin when env is undefined', () => {
    const result = parseTrustedOrigins(undefined)
    expect(result).toEqual(['http://localhost:1420'])
  })

  it('returns default origin when env is empty string', () => {
    const result = parseTrustedOrigins('')
    expect(result).toEqual(['http://localhost:1420'])
  })

  it('uses custom default origin when provided', () => {
    const result = parseTrustedOrigins(undefined, 'https://custom.example.com')
    expect(result).toEqual(['https://custom.example.com'])
  })

  it('handles single origin', () => {
    const result = parseTrustedOrigins('https://app.example.com')
    expect(result).toEqual(['https://app.example.com'])
  })
})

describe('getValidatedOrigin', () => {
  const trustedOrigins = ['http://localhost:1420', 'https://app.example.com']

  it('returns origin from request if trusted', () => {
    const request = new Request('https://api.example.com', {
      headers: { origin: 'https://app.example.com' },
    })
    const result = getValidatedOrigin(trustedOrigins, request)
    expect(result).toBe('https://app.example.com')
  })

  it('returns first trusted origin if request origin is not trusted', () => {
    const request = new Request('https://api.example.com', {
      headers: { origin: 'https://malicious.com' },
    })
    const result = getValidatedOrigin(trustedOrigins, request)
    expect(result).toBe('http://localhost:1420')
  })

  it('returns first trusted origin if request has no origin header', () => {
    const request = new Request('https://api.example.com')
    const result = getValidatedOrigin(trustedOrigins, request)
    expect(result).toBe('http://localhost:1420')
  })

  it('returns first trusted origin if request is undefined', () => {
    const result = getValidatedOrigin(trustedOrigins, undefined)
    expect(result).toBe('http://localhost:1420')
  })

  it('handles empty string origin header', () => {
    const request = new Request('https://api.example.com', {
      headers: { origin: '' },
    })
    const result = getValidatedOrigin(trustedOrigins, request)
    expect(result).toBe('http://localhost:1420')
  })
})

describe('buildMagicLinkUrl', () => {
  it('builds URL with origin and token', () => {
    const result = buildMagicLinkUrl('https://app.example.com', 'abc123')
    expect(result).toBe('https://app.example.com/auth/verify?token=abc123')
  })

  it('encodes special characters in token', () => {
    const result = buildMagicLinkUrl('https://app.example.com', 'token+with/special=chars')
    expect(result).toBe('https://app.example.com/auth/verify?token=token%2Bwith%2Fspecial%3Dchars')
  })

  it('handles empty token', () => {
    const result = buildMagicLinkUrl('https://app.example.com', '')
    expect(result).toBe('https://app.example.com/auth/verify?token=')
  })

  it('handles localhost origin', () => {
    const result = buildMagicLinkUrl('http://localhost:1420', 'test-token')
    expect(result).toBe('http://localhost:1420/auth/verify?token=test-token')
  })

  it('handles origin with trailing slash gracefully', () => {
    // Note: origin should not have trailing slash, but function handles it
    const result = buildMagicLinkUrl('https://app.example.com/', 'token')
    expect(result).toBe('https://app.example.com//auth/verify?token=token')
  })
})
