import { describe, expect, it } from 'bun:test'
import { buildVerifyUrl, getValidatedOrigin, isDeepLinkPlatform, parseTrustedOrigins } from './utils'

describe('parseTrustedOrigins', () => {
  it('parses comma-separated origins and adds tauri origin', () => {
    const result = parseTrustedOrigins('http://localhost:1420,https://app.example.com')
    expect(result).toEqual(['http://localhost:1420', 'https://app.example.com', 'tauri://localhost'])
  })

  it('filters empty values from comma-separated string', () => {
    const result = parseTrustedOrigins('http://localhost:1420,,https://app.example.com,')
    expect(result).toEqual(['http://localhost:1420', 'https://app.example.com', 'tauri://localhost'])
  })

  it('returns default origins when env is undefined', () => {
    const result = parseTrustedOrigins(undefined)
    expect(result).toEqual(['http://localhost:1420', 'tauri://localhost'])
  })

  it('returns default origins when env is empty string', () => {
    const result = parseTrustedOrigins('')
    expect(result).toEqual(['http://localhost:1420', 'tauri://localhost'])
  })

  it('handles single origin and adds tauri origin', () => {
    const result = parseTrustedOrigins('https://app.example.com')
    expect(result).toEqual(['https://app.example.com', 'tauri://localhost'])
  })

  it('does not duplicate tauri origin if already included', () => {
    const result = parseTrustedOrigins('http://localhost:1420,tauri://localhost')
    expect(result).toEqual(['http://localhost:1420', 'tauri://localhost'])
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

describe('isDeepLinkPlatform', () => {
  it('returns true for iOS platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'ios' },
    })
    expect(isDeepLinkPlatform(request)).toBe(true)
  })

  it('returns true for Android platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'android' },
    })
    expect(isDeepLinkPlatform(request)).toBe(true)
  })

  it('returns false for web platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'web' },
    })
    expect(isDeepLinkPlatform(request)).toBe(false)
  })

  it('returns false for desktop platforms', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'macos' },
    })
    expect(isDeepLinkPlatform(request)).toBe(false)
  })

  it('returns false when request is undefined', () => {
    expect(isDeepLinkPlatform(undefined)).toBe(false)
  })

  it('returns false when platform header is missing', () => {
    const request = new Request('https://api.example.com')
    expect(isDeepLinkPlatform(request)).toBe(false)
  })
})

describe('buildVerifyUrl', () => {
  it('builds URL with email and otp for non-mobile platforms', () => {
    const result = buildVerifyUrl('https://app.example.com', 'user@example.com', '123456')
    expect(result).toBe('https://app.example.com/auth/verify?email=user%40example.com&otp=123456')
  })

  it('uses deep link URL for iOS platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'ios' },
    })
    const result = buildVerifyUrl('https://app.example.com', 'user@example.com', '123456', request)
    expect(result).toBe('https://thunderbolt.io/auth/verify?email=user%40example.com&otp=123456')
  })

  it('uses deep link URL for Android platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'android' },
    })
    const result = buildVerifyUrl('https://app.example.com', 'user@example.com', '123456', request)
    expect(result).toBe('https://thunderbolt.io/auth/verify?email=user%40example.com&otp=123456')
  })

  it('uses origin URL for web platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'web' },
    })
    const result = buildVerifyUrl('https://app.example.com', 'user@example.com', '123456', request)
    expect(result).toBe('https://app.example.com/auth/verify?email=user%40example.com&otp=123456')
  })

  it('uses origin URL for desktop platform', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-client-platform': 'macos' },
    })
    const result = buildVerifyUrl('https://app.example.com', 'user@example.com', '123456', request)
    expect(result).toBe('https://app.example.com/auth/verify?email=user%40example.com&otp=123456')
  })

  it('encodes special characters in email', () => {
    const result = buildVerifyUrl('https://app.example.com', 'user+tag@example.com', '123456')
    expect(result).toBe('https://app.example.com/auth/verify?email=user%2Btag%40example.com&otp=123456')
  })

  it('handles localhost origin', () => {
    const result = buildVerifyUrl('http://localhost:1420', 'user@example.com', '123456')
    expect(result).toBe('http://localhost:1420/auth/verify?email=user%40example.com&otp=123456')
  })
})
