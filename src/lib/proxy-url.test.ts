/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { getProxyUrl, useProxyUrl } from './proxy-url'
import { createTestProvider } from '@/test-utils/test-provider'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'

const testJwt = 'test-jwt-token'

describe('getProxyUrl', () => {
  it('on web with JWT, returns proxied URL with ?token= suffix', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        mediaJwt: testJwt,
        isTauriPlatform: false,
      }),
    ).toBe(
      `http://localhost:8000/v1/proxy/${encodeURIComponent('https://example.com/api')}?token=${encodeURIComponent(testJwt)}`,
    )
  })

  it('on web with proxyEnabled=false (web ignores the flag), still proxies when JWT present', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: false,
        mediaJwt: testJwt,
        isTauriPlatform: false,
      }),
    ).toBe(
      `http://localhost:8000/v1/proxy/${encodeURIComponent('https://example.com/api')}?token=${encodeURIComponent(testJwt)}`,
    )
  })

  it('on web with no JWT yet, returns null (caller renders fallback)', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        mediaJwt: null,
        isTauriPlatform: false,
      }),
    ).toBeNull()
  })

  it('on Tauri with proxyEnabled=true and JWT, returns proxied URL with ?token=', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        mediaJwt: testJwt,
        isTauriPlatform: true,
      }),
    ).toBe(
      `http://localhost:8000/v1/proxy/${encodeURIComponent('https://example.com/api')}?token=${encodeURIComponent(testJwt)}`,
    )
  })

  it('on Tauri with proxyEnabled=false, returns target unchanged (JWT not needed)', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: false,
        mediaJwt: null,
        isTauriPlatform: true,
      }),
    ).toBe('https://example.com/api')
  })

  it('on Tauri with proxyEnabled=true but no JWT, returns null', () => {
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        mediaJwt: null,
        isTauriPlatform: true,
      }),
    ).toBeNull()
  })

  it('encodes JWT special characters safely', () => {
    const jwtWithSpecialChars = 'header.payload.sig+with/special=chars'
    expect(
      getProxyUrl('https://example.com/api', {
        cloudUrl: 'http://localhost:8000/v1',
        proxyEnabled: true,
        mediaJwt: jwtWithSpecialChars,
        isTauriPlatform: false,
      }),
    ).toBe(
      `http://localhost:8000/v1/proxy/${encodeURIComponent('https://example.com/api')}?token=${encodeURIComponent(jwtWithSpecialChars)}`,
    )
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

  it('wires cloud_url + proxy_enabled localStorage + mediaJwt through to getProxyUrl', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const { result } = renderHook(() => useProxyUrl({ isTauriPlatform: true }), {
      wrapper: createTestProvider({ mediaJwt: testJwt }),
    })
    const fn = result.current
    expect(fn('https://example.com/api')).toBe(
      `http://localhost:8000/v1/proxy/${encodeURIComponent('https://example.com/api')}?token=${encodeURIComponent(testJwt)}`,
    )
  })
})
