/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { useSidebarPreviewState } from './use-sidebar-preview-state'

const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index + 1}` }))

it('reveals five more items per click, then collapses back to five', () => {
  const { result } = renderHook(() => useSidebarPreviewState(items))
  expect(result.current.items).toEqual(items.slice(0, 5))
  expect(result.current.hasOverflow).toBe(true)
  act(() => result.current.toggle())
  expect(result.current.items).toEqual(items.slice(0, 10))
  expect(result.current.showAll).toBe(false)
  act(() => result.current.toggle())
  expect(result.current.items).toEqual(items)
  expect(result.current.showAll).toBe(true)
  act(() => result.current.toggle())
  expect(result.current.items).toEqual(items.slice(0, 5))
})

it('keeps an older selected item visible within the five-item limit', () => {
  const { result, rerender } = renderHook(({ selected }) => useSidebarPreviewState(items, selected), {
    initialProps: { selected: 'item-12' },
  })
  expect(result.current.items).toEqual([...items.slice(0, 4), items[11]])
  act(() => result.current.toggle())
  expect(result.current.items).toEqual([...items.slice(0, 9), items[11]])
  act(() => result.current.toggle())
  act(() => result.current.toggle())
  expect(result.current.items.at(-1)?.id).toBe('item-12')
  rerender({ selected: 'item-2' })
  expect(result.current.items).toEqual(items.slice(0, 5))
  rerender({ selected: 'not-in-this-section' })
  expect(result.current.items).toEqual(items.slice(0, 5))
})

it('only offers expansion when the live collection exceeds five items', () => {
  const { result, rerender } = renderHook(({ count }) => useSidebarPreviewState(items.slice(0, count)), {
    initialProps: { count: 0 },
  })
  expect(result.current.hasOverflow).toBe(false)
  rerender({ count: 5 })
  expect(result.current.hasOverflow).toBe(false)
  rerender({ count: 6 })
  expect(result.current.hasOverflow).toBe(true)
  act(() => result.current.toggle())
  rerender({ count: 4 })
  expect(result.current.hasOverflow).toBe(false)
  expect(result.current.items).toHaveLength(4)
})
