import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockPlatform = mock(() => 'ios' as const)
mock.module('@tauri-apps/plugin-os', () => ({
  platform: () => mockPlatform(),
}))

import { getWebBrowser, isPrPreview, prPreviewHostRegex } from './platform'

describe('getWebBrowser', () => {
  beforeEach(() => {
    delete (window as { isTauri?: boolean }).isTauri
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    })
  })

  afterEach(() => {
    mockPlatform.mockRestore?.()
  })

  it('returns safari for Safari user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    })
    expect(getWebBrowser()).toBe('safari')
  })

  it('returns chrome for Chrome user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
    expect(getWebBrowser()).toBe('chrome')
  })

  it('returns edge for Edge user agent (Chrome-based)', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    })
    expect(getWebBrowser()).toBe('edge')
  })

  it('returns firefox for Firefox user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    })
    expect(getWebBrowser()).toBe('firefox')
  })

  it('returns unknown for unrecognized user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'SomeBot/1.0',
    })
    expect(getWebBrowser()).toBe('unknown')
  })

  it('returns unknown when not on web (Tauri)', () => {
    ;(window as { isTauri?: boolean }).isTauri = true
    expect(getWebBrowser()).toBe('unknown')
  })
})

describe('prPreviewHostRegex', () => {
  it('matches thunderbolt-pr-{number}.onrender.com hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt-pr-368.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-1.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-9999.onrender.com')).toBe(true)
  })

  it('rejects non-matching hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr-368x.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('localhost')).toBe(false)
    expect(prPreviewHostRegex.test('')).toBe(false)
  })
})

describe('isPrPreview', () => {
  const originalLocation = window.location

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    })
  })

  it('returns true when hostname matches PR preview pattern', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'thunderbolt-pr-368.onrender.com' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(true)
  })

  it('returns false when hostname does not match', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'localhost' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(false)
  })
})
