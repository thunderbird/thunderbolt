/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useSearchParams } from 'react-router'
import { useResourcePageState } from './use-resource-page-state'

const renderState = (path = '/admin/groups') =>
  renderHook(() => ({ page: useResourcePageState(), params: useSearchParams() }), {
    wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
  })

describe('useResourcePageState', () => {
  it('reads and writes the selection in the URL', () => {
    const { result } = renderState('/admin/groups?edit=g1')
    expect(result.current.page.selectedId).toBe('g1')

    act(() => result.current.page.select('g2'))
    expect(result.current.params[0].get('edit')).toBe('g2')

    act(() => result.current.page.close())
    expect(result.current.page.selectedId).toBeNull()
  })

  it('holds a selection change while the form has unsaved edits', () => {
    const { result } = renderState('/admin/groups?edit=g1')
    act(() => result.current.page.patch({ dirty: true }))

    act(() => result.current.page.requestSelect('g2'))
    expect(result.current.page.selectedId).toBe('g1')
    expect(result.current.page.pendingSelection).toEqual({ id: 'g2' })
  })

  it('drops the draft state when the URL changes the selection', () => {
    const { result } = renderState('/admin/groups?edit=g1')
    act(() => result.current.page.patch({ dirty: true }))

    act(() => result.current.params[1]({ edit: 'g3' }))
    expect(result.current.page.selectedId).toBe('g3')
    expect(result.current.page.dirty).toBe(false)
  })

  it('keeps the other search params when the panel opens and closes', () => {
    const { result } = renderState('/admin/link-reviews?status=rejected&connection=c1')

    act(() => result.current.page.select('r1'))
    expect(result.current.params[0].toString()).toBe('status=rejected&connection=c1&edit=r1')

    act(() => result.current.page.close())
    expect(result.current.params[0].toString()).toBe('status=rejected&connection=c1')
  })
})
