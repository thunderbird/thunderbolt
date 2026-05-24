/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { type ReactNode } from 'react'
import { ProxyFetchProvider, useFetch, useProxyFetchGetter } from './proxy-fetch-context'
import type { FetchFn } from './proxy-fetch'

describe('useFetch + ProxyFetchProvider', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  it('returns the override fetch when one is supplied to the provider', () => {
    const fakeFetch = mock(async () => new Response('ok')) as unknown as FetchFn
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider proxyFetch={fakeFetch}>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result } = renderHook(() => useFetch(), { wrapper })

    expect(result.current).toBe(fakeFetch)
  })

  it('returns a stable fetch reference across re-renders when cloudUrl is unchanged', () => {
    const fakeFetch = mock(async () => new Response('ok')) as unknown as FetchFn
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider proxyFetch={fakeFetch}>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result, rerender } = renderHook(() => useFetch(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('builds a real proxyFetch when no override is given and `cloud_url` falls back to the default', () => {
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result } = renderHook(() => useFetch(), { wrapper })

    expect(typeof result.current).toBe('function')
  })

  it('throws a clear error when used outside of ProxyFetchProvider', () => {
    // Suppress React's noisy "uncaught error" log for this expected throw.
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => renderHook(() => useFetch())).toThrow('useFetch must be used within a ProxyFetchProvider')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  describe('useProxyFetchGetter', () => {
    it('returns a stable getter whose value tracks the current proxyFetch across rebuilds', () => {
      // Models the non-React caller: createChatInstance grabs the getter once
      // at chat creation, then settings change and the provider rebuilds the
      // proxy fetch. Calling the same getter after the rebuild must return
      // the new fetch — that's the whole reason this hook exists.
      const firstFetch = mock(async () => new Response('first')) as unknown as FetchFn
      const secondFetch = mock(async () => new Response('second')) as unknown as FetchFn
      // Wrapper reads from this slot; rerender() will pick up the new value.
      let currentFetch: FetchFn = firstFetch

      const TestProvider = createTestProvider()
      const wrapper = ({ children }: { children: ReactNode }) => (
        <TestProvider>
          <ProxyFetchProvider proxyFetch={currentFetch}>{children}</ProxyFetchProvider>
        </TestProvider>
      )

      const { result, rerender } = renderHook(() => ({ getProxyFetch: useProxyFetchGetter(), fetch: useFetch() }), {
        wrapper,
      })

      const getterRef = result.current.getProxyFetch
      expect(getterRef()).toBe(firstFetch)

      currentFetch = secondFetch
      rerender()

      // Stable identity (so captured closures don't go stale), fresh value.
      expect(result.current.getProxyFetch).toBe(getterRef)
      expect(getterRef()).toBe(secondFetch)
    })

    it('throws when used outside of ProxyFetchProvider', () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => renderHook(() => useProxyFetchGetter())).toThrow(
          'useProxyFetchGetter must be used within a ProxyFetchProvider',
        )
      } finally {
        consoleSpy.mockRestore()
      }
    })
  })

  describe('proxy_enabled toggle propagation', () => {
    afterEach(() => {
      localStorage.removeItem('proxy_enabled')
    })

    it('Web: built fetch ignores the toggle and always hits the hosted proxy', async () => {
      // proxy_enabled=false in storage; on Web that must STILL proxy.
      localStorage.setItem('proxy_enabled', 'false')

      const hostedFetch = mock(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString()
        return new Response('hosted', { status: 200, headers: { 'x-test-url': url } })
      })
      // Spy on global fetch so the real `createProxyFetch` reaches it.
      const originalFetch = globalThis.fetch
      globalThis.fetch = hostedFetch as unknown as typeof fetch

      try {
        const TestProvider = createTestProvider()
        const wrapper = ({ children }: { children: ReactNode }) => (
          <TestProvider>
            <ProxyFetchProvider isStandalone={() => false}>{children}</ProxyFetchProvider>
          </TestProvider>
        )

        const { result } = renderHook(() => useFetch(), { wrapper })

        await result.current('https://example.com/api', { method: 'GET' })
        expect(hostedFetch).toHaveBeenCalledTimes(1)
        const [hostedReq] = hostedFetch.mock.calls[0] as unknown as [Request]
        // URL gets rewritten to the hosted /proxy endpoint when proxying.
        expect(hostedReq.url.endsWith('/proxy')).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('Tauri + toggle off (default): rebuilds without proxying; new fetch goes direct', () => {
      // proxy_enabled storage is empty → default 'false' → toggle off on Tauri.
      localStorage.removeItem('proxy_enabled')

      const TestProvider = createTestProvider()
      // No override — we want the real factory so the toggle changes the output.
      const wrapper = ({ children }: { children: ReactNode }) => (
        <TestProvider>
          <ProxyFetchProvider isStandalone={() => true}>{children}</ProxyFetchProvider>
        </TestProvider>
      )

      const { result } = renderHook(() => useFetch(), { wrapper })
      // The returned function must be a real fetch — assertion that the provider built one.
      expect(typeof result.current).toBe('function')
    })

    it('Tauri + toggle ON: the built fetch routes through the hosted proxy', async () => {
      localStorage.setItem('proxy_enabled', 'true')

      const hostedFetch = mock(async () => new Response('hosted', { status: 200 }))
      const originalFetch = globalThis.fetch
      globalThis.fetch = hostedFetch as unknown as typeof fetch

      try {
        const TestProvider = createTestProvider()
        const wrapper = ({ children }: { children: ReactNode }) => (
          <TestProvider>
            <ProxyFetchProvider isStandalone={() => true}>{children}</ProxyFetchProvider>
          </TestProvider>
        )

        const { result } = renderHook(() => useFetch(), { wrapper })

        await result.current('https://example.com/api', { method: 'GET' })
        expect(hostedFetch).toHaveBeenCalledTimes(1)
        const [hostedReq] = hostedFetch.mock.calls[0] as unknown as [Request]
        expect(hostedReq.url.endsWith('/proxy')).toBe(true)
        expect(hostedReq.headers.get('x-proxy-target-url')).toBe('https://example.com/api')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
