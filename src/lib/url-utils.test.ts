import { describe, expect, it } from 'bun:test'
import { deriveFaviconUrl, getProxiedFaviconUrl, isSafeUrl } from './url-utils'

describe('isSafeUrl', () => {
  it('accepts http URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true)
  })

  it('accepts https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
  })

  it('rejects javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<h1>hi</h1>')).toBe(false)
  })

  it('rejects invalid URLs', () => {
    expect(isSafeUrl('not a url')).toBe(false)
  })
})

describe('getProxiedFaviconUrl', () => {
  it('proxies favicon URL through proxy base with encoding', () => {
    expect(getProxiedFaviconUrl('https://example.com/favicon.ico', 'https://cloud.com')).toBe(
      'https://cloud.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico',
    )
  })

  it('returns original URL if proxy base is empty', () => {
    expect(getProxiedFaviconUrl('https://example.com/favicon.ico', '')).toBe('https://example.com/favicon.ico')
  })

  it('encodes special characters in favicon URLs', () => {
    expect(getProxiedFaviconUrl('https://example.com/favicon.ico?v=2', 'https://proxy.com')).toBe(
      'https://proxy.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico%3Fv%3D2',
    )
  })
})

describe('deriveFaviconUrl', () => {
  it('derives /favicon.ico from page URL origin', () => {
    expect(deriveFaviconUrl('https://example.com/article/123')).toBe('https://example.com/favicon.ico')
  })

  it('proxies derived favicon when proxyBase is provided', () => {
    expect(deriveFaviconUrl('https://example.com/article', 'http://localhost:8000/v1')).toBe(
      'http://localhost:8000/v1/pro/proxy/' + encodeURIComponent('https://example.com/favicon.ico'),
    )
  })

  it('returns null for invalid URLs', () => {
    expect(deriveFaviconUrl('not a url')).toBeNull()
  })
})
