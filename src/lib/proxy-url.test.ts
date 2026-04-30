import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { getProxyUrl, useProxyUrl } from './proxy-url'
import { createTestProvider } from '@/test-utils/test-provider'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'

describe('getProxyUrl', () => {
  it('on web, returns proxied URL when proxyEnabled is true', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        isTauriPlatform: false,
      }),
    ).toBe('http://localhost:8000/v1/proxy/' + encodeURIComponent('https://example.com/api'))
  })

  it('on web, returns proxied URL when proxyEnabled is false (web ignores the flag)', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: false,
        isTauriPlatform: false,
      }),
    ).toBe('http://localhost:8000/v1/proxy/' + encodeURIComponent('https://example.com/api'))
  })

  it('on Tauri, returns proxied URL when proxyEnabled is true', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        isTauriPlatform: true,
      }),
    ).toBe('http://localhost:8000/v1/proxy/' + encodeURIComponent('https://example.com/api'))
  })

  it('on Tauri, returns target unchanged when proxyEnabled is false', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: false,
        isTauriPlatform: true,
      }),
    ).toBe('https://example.com/api')
  })
})

describe('useProxyUrl', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })
  afterAll(async () => {
    await teardownTestDatabase()
  })
  afterEach(async () => {
    await resetTestDatabase()
  })
  beforeEach(() => {
    localStorage.clear()
  })

  it('wires cloud_url + proxy_enabled localStorage through to getProxyUrl', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const { result } = renderHook(() => useProxyUrl({ isTauriPlatform: true }), {
      wrapper: createTestProvider(),
    })
    const fn = result.current
    expect(fn('https://example.com/api')).toBe(
      'http://localhost:8000/v1/proxy/' + encodeURIComponent('https://example.com/api'),
    )
  })
})
