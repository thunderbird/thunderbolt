import { describe, expect, it } from 'bun:test'
import { decodeUrlParam, resolveUrl, validateSafeUrl } from './url'

describe('validateSafeUrl', () => {
  it('allows valid http URLs', () => {
    expect(validateSafeUrl('http://example.com')).toEqual({ valid: true })
  })

  it('allows valid https URLs', () => {
    expect(validateSafeUrl('https://example.com/path?q=1')).toEqual({ valid: true })
  })

  it('rejects non-http protocols', () => {
    expect(validateSafeUrl('ftp://example.com')).toEqual({
      valid: false,
      error: 'Only HTTP and HTTPS URLs are supported',
    })
    expect(validateSafeUrl('file:///etc/passwd')).toEqual({
      valid: false,
      error: 'Only HTTP and HTTPS URLs are supported',
    })
  })

  it('rejects localhost', () => {
    expect(validateSafeUrl('http://localhost:3000')).toEqual({
      valid: false,
      error: 'Internal URLs are not allowed',
    })
    expect(validateSafeUrl('http://127.0.0.1')).toEqual({
      valid: false,
      error: 'Internal URLs are not allowed',
    })
  })

  it('rejects private IP ranges', () => {
    expect(validateSafeUrl('http://10.0.0.1')).toEqual({ valid: false, error: 'Internal URLs are not allowed' })
    expect(validateSafeUrl('http://192.168.1.1')).toEqual({ valid: false, error: 'Internal URLs are not allowed' })
    expect(validateSafeUrl('http://172.16.0.1')).toEqual({ valid: false, error: 'Internal URLs are not allowed' })
  })

  it('rejects link-local addresses', () => {
    expect(validateSafeUrl('http://169.254.1.1')).toEqual({ valid: false, error: 'Internal URLs are not allowed' })
  })

  it('rejects invalid URLs', () => {
    expect(validateSafeUrl('not-a-url')).toEqual({ valid: false, error: 'Invalid URL' })
  })

  it('rejects IPv6 loopback', () => {
    expect(validateSafeUrl('http://[::1]')).toEqual({ valid: false, error: 'Internal URLs are not allowed' })
  })
})

describe('resolveUrl', () => {
  it('resolves relative URLs against a base', () => {
    expect(resolveUrl('https://example.com/page', '/image.png')).toBe('https://example.com/image.png')
  })

  it('returns absolute URLs unchanged', () => {
    expect(resolveUrl('https://example.com', 'https://cdn.example.com/img.png')).toBe('https://cdn.example.com/img.png')
  })

  it('returns the input on invalid base', () => {
    expect(resolveUrl('not-a-url', 'also-not-a-url')).toBe('also-not-a-url')
  })
})

describe('decodeUrlParam', () => {
  it('decodes valid URL-encoded strings', () => {
    expect(decodeUrlParam('hello%20world')).toBe('hello world')
    expect(decodeUrlParam('https%3A%2F%2Fexample.com')).toBe('https://example.com')
  })

  it('returns null for invalid encoding', () => {
    expect(decodeUrlParam('%E0%A4%A')).toBeNull()
  })

  it('returns plain strings as-is', () => {
    expect(decodeUrlParam('plain-text')).toBe('plain-text')
  })
})
