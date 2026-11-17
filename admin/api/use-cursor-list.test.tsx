/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { Page } from '@shared/admin-api'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { useCursorList } from './use-cursor-list'

const createWrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

const renderList = (fetchPage: (cursor: string | undefined) => Promise<Page<string>>) =>
  renderHook(() => useCursorList({ queryKey: ['admin', 'test'], fetchPage }), { wrapper: createWrapper().wrapper })

/** Settle every pending query under the suite's fake clock. */
const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })

const pages: Record<string, Page<string>> = {
  first: { items: ['a', 'b'], nextCursor: 'c2' },
  c2: { items: ['c'], nextCursor: null },
}

describe('useCursorList', () => {
  it('loads more pages by cursor until the last one', async () => {
    const cursors: (string | undefined)[] = []
    const { result } = renderList(async (cursor) => {
      cursors.push(cursor)
      return pages[cursor ?? 'first']
    })
    expect(result.current.isLoading).toBe(true)

    await flush()
    expect(result.current.items).toEqual(['a', 'b'])
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await flush()
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.isEmpty).toBe(false)
    expect(cursors).toEqual([undefined, 'c2'])
  })

  it('reports an empty list', async () => {
    const { result } = renderList(async () => ({ items: [], nextCursor: null }))
    await flush()
    expect(result.current.isEmpty).toBe(true)
    expect(result.current.hasMore).toBe(false)
  })

  it('reports a first page that fails', async () => {
    const { result } = renderList(async () => {
      throw new Error('down')
    })
    await flush()
    expect(result.current.error?.message).toBe('down')
    expect(result.current.items).toEqual([])
    expect(result.current.isEmpty).toBe(false)
  })

  it('keeps the loaded items when the next page fails', async () => {
    const { result } = renderList(async (cursor) => {
      if (cursor) {
        throw new Error('down')
      }
      return pages.first
    })
    await flush()
    expect(result.current.items).toEqual(['a', 'b'])

    act(() => result.current.loadMore())
    await flush()
    expect(result.current.error?.message).toBe('down')
    expect(result.current.items).toEqual(['a', 'b'])
  })

  it('never shares a cache entry with a plain query on the same key, and refreshes with it', async () => {
    const { client, wrapper } = createWrapper()
    let version = 1
    const { result } = renderHook(
      () => ({
        list: useCursorList({
          queryKey: ['admin', 'test'],
          fetchPage: async () => ({ items: [`item ${version}`], nextCursor: null }),
        }),
        plain: useQuery({ queryKey: ['admin', 'test'], queryFn: async () => `plain ${version}` }),
      }),
      { wrapper },
    )
    await flush()
    expect(result.current.list.items).toEqual(['item 1'])
    expect(result.current.plain.data).toBe('plain 1')

    version = 2
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['admin'] })
    })
    await flush()
    expect(result.current.list.items).toEqual(['item 2'])
    expect(result.current.plain.data).toBe('plain 2')
  })
})
