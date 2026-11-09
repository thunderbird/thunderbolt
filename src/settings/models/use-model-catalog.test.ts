/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import type { CatalogRequest } from './model-catalog'
import { createElement, type ReactNode } from 'react'
import {
  catalogToComboboxItems,
  initialModelCatalogState,
  modelCatalogReducer,
  useModelCatalog,
  useAutoCatalogFetch,
} from './use-model-catalog'

describe('modelCatalogReducer', () => {
  it('ignores stale catalog results after a newer request starts', () => {
    const first = modelCatalogReducer(initialModelCatalogState, { type: 'CATALOG_REQUESTED', requestKey: 'first' })
    const second = modelCatalogReducer(first, { type: 'CATALOG_REQUESTED', requestKey: 'second' })
    const stale = modelCatalogReducer(second, {
      type: 'CATALOG_LOADED',
      requestKey: 'first',
      models: [{ id: 'stale', name: 'Stale' }],
    })

    expect(stale).toBe(second)
  })

  it('ignores stale failures the same way', () => {
    const loading = modelCatalogReducer(initialModelCatalogState, { type: 'CATALOG_REQUESTED', requestKey: 'new' })
    expect(modelCatalogReducer(loading, { type: 'CATALOG_FAILED', requestKey: 'old', error: 'boom' })).toBe(loading)
  })

  it('resets everything on invalidation', () => {
    const loaded = modelCatalogReducer(
      { ...initialModelCatalogState, requestKey: 'request', isLoading: true },
      { type: 'CATALOG_LOADED', requestKey: 'request', models: [{ id: 'model', name: 'Model' }] },
    )

    expect(modelCatalogReducer(loaded, { type: 'CATALOG_INVALIDATED' })).toEqual(initialModelCatalogState)
  })
})

describe('catalogToComboboxItems', () => {
  it('labels entries by name with the id as description, falling back to the id', () => {
    expect(catalogToComboboxItems([{ id: 'gpt-4', name: 'GPT-4' }, { id: 'bare-id' }])).toEqual([
      { id: 'gpt-4', label: 'GPT-4', description: 'gpt-4' },
      { id: 'bare-id', label: 'bare-id', description: undefined },
    ])
  })
})

describe('useModelCatalog', () => {
  it('fetches custom catalogs through the proxy from context', async () => {
    const proxyFetch = Object.assign(
      mock(async () => Response.json({ data: [] })),
      { preconnect: async () => false },
    )
    const { result } = renderHook(() => useModelCatalog(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(ProxyFetchProvider, { proxyFetch, children }),
    })

    await act(() => result.current.fetchCatalog({ provider: 'custom', url: 'https://api.otari.ai/api/v1' }))

    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })
})

describe('catalog attempt identity', () => {
  it.each([false, true])('ignores a late same-input attempt after retry (invalidate=%s)', async (invalidate) => {
    const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    const queue = [...responses]
    const proxyFetch = Object.assign(
      mock(() => queue.shift()!.promise),
      { preconnect: async () => false },
    )
    const { result } = renderHook(() => useModelCatalog(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(ProxyFetchProvider, { proxyFetch, children }),
    })
    const request = { provider: 'custom', url: 'https://example.com/v1' } as const
    const runs: Promise<void>[] = []
    act(() => {
      runs.push(result.current.fetchCatalog(request))
    })
    if (invalidate) {
      act(() => result.current.invalidateCatalog())
    }
    act(() => {
      runs.push(result.current.fetchCatalog(request))
    })
    await act(async () => {
      responses[1].resolve(Response.json({ data: [{ id: 'current' }] }))
      await runs[1]
    })
    await act(async () => {
      responses[0].resolve(Response.json({ data: [{ id: 'stale' }] }))
      await runs[0]
    })
    expect(result.current.models.map((model) => model.id)).toEqual(['current'])
    expect(result.current.isLoading).toBe(false)
  })
})

describe('catalog errors and automatic fetching', () => {
  it('ignores superseded errors and clears an active error when retried', async () => {
    const old = Promise.withResolvers<Response>()
    const proxyFetch = Object.assign(
      mock()
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(async () => {
          throw new Error('current failure')
        })
        .mockImplementationOnce(async () => Response.json({ data: [{ id: 'recovered' }] })),
      { preconnect: async () => false },
    )
    const { result } = renderHook(() => useModelCatalog(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(ProxyFetchProvider, { proxyFetch, children }),
    })
    const request: CatalogRequest = { provider: 'custom', url: 'https://example.com/v1' }
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      let first: Promise<void>
      act(() => {
        first = result.current.fetchCatalog(request)
      })
      await act(() => result.current.fetchCatalog(request))
      expect(result.current.error).toBe('Failed to load models')
      expect(result.current.isLoading).toBe(false)
      await act(async () => {
        old.reject(new Error('stale failure'))
        await first
      })
      expect(result.current.error).toBe('Failed to load models')
      expect(log).toHaveBeenCalledTimes(1)
      await act(() => result.current.fetchCatalog(request))
      expect(result.current.error).toBeNull()
      expect(result.current.models).toEqual([{ id: 'recovered' }])
    } finally {
      log.mockRestore()
    }
  })

  it('does not publish an error after the catalog is invalidated or unmounted', async () => {
    const response = Promise.withResolvers<Response>()
    const proxyFetch = Object.assign(
      mock(() => response.promise),
      { preconnect: async () => false },
    )
    const { result, unmount } = renderHook(() => useModelCatalog(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(ProxyFetchProvider, { proxyFetch, children }),
    })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      let pending: Promise<void>
      act(() => {
        pending = result.current.fetchCatalog({ provider: 'custom', url: 'https://example.com' })
      })
      act(() => result.current.invalidateCatalog())
      expect(result.current.requestKey).toBeNull()
      unmount()
      await act(async () => {
        response.reject(new Error('late failure'))
        await pending
      })
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('requires arming, complete inputs and the full debounce before sending credentials', async () => {
    const proxyFetch = Object.assign(
      mock(async (_input: RequestInfo | URL) => Response.json({ data: [] })),
      { preconnect: async () => false },
    )
    const { rerender } = renderHook(
      ({ armed, request }: { armed: boolean; request: CatalogRequest }) => {
        const catalog = useModelCatalog()
        useAutoCatalogFetch({ armed, request, catalog })
        return catalog
      },
      {
        initialProps: { armed: false, request: { provider: 'custom', url: '', apiKey: 'secret' } },
        wrapper: ({ children }: { children: ReactNode }) => createElement(ProxyFetchProvider, { proxyFetch, children }),
      },
    )
    rerender({ armed: true, request: { provider: 'custom', url: '', apiKey: 'secret' } })
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(proxyFetch).not.toHaveBeenCalled()
    rerender({ armed: true, request: { provider: 'custom', url: 'https://example.com/v1', apiKey: 'old' } })
    await act(async () => {
      await getClock().tickAsync(499)
    })
    expect(proxyFetch).not.toHaveBeenCalled()
    rerender({ armed: true, request: { provider: 'custom', url: 'https://example.com/v1', apiKey: 'new' } })
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    const request = proxyFetch.mock.calls[0][0] as Request
    expect(request.headers.get('Authorization')).toBe('Bearer new')
    rerender({ armed: true, request: { provider: 'custom', url: 'https://example.com/v1', apiKey: 'new' } })
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    rerender({ armed: false, request: { provider: 'custom', url: 'https://other.example/v1', apiKey: 'new' } })
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })
})
