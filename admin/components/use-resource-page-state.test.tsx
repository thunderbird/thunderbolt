/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { ComponentProps, ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { flush } from '../test-utils'
import { adminItemLink, useResourcePageState } from './use-resource-page-state'

const renderState = (entry: ComponentProps<typeof MemoryRouter>['initialEntries'] = ['/admin/groups']) =>
  renderHook(() => ({ page: useResourcePageState(), location: useLocation() }), {
    wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={entry}>{children}</MemoryRouter>,
  })

describe('useResourcePageState', () => {
  it('holds the selection in state and leaves the URL alone', () => {
    const { result } = renderState()

    act(() => result.current.page.select('g1'))
    expect(result.current.page.selectedId).toBe('g1')
    expect(result.current.location.search).toBe('')

    act(() => result.current.page.close())
    expect(result.current.page.selectedId).toBeNull()
  })

  it('opens the item another screen links to, then clears the link', async () => {
    const link = adminItemLink('/admin/groups', 'g1')
    const { result } = renderState([{ pathname: link.to, state: link.state }])
    await flush()

    expect(result.current.page.selectedId).toBe('g1')
    expect(result.current.page.isEditing).toBe(false)
    expect(result.current.location.state).toEqual({})
  })

  it('holds a selection change while the form has unsaved edits', () => {
    const { result } = renderState()
    act(() => result.current.page.select('g1'))
    act(() => result.current.page.patch({ dirty: true }))

    act(() => result.current.page.requestSelect('g2'))
    expect(result.current.page.selectedId).toBe('g1')
    expect(result.current.page.pendingSelection).toEqual({ id: 'g2', editing: false })
  })

  it('opens the edit form, and leaves it for the view panel', () => {
    const { result } = renderState()
    act(() => result.current.page.select('g1'))

    act(() => result.current.page.edit('g1'))
    expect(result.current.page.isEditing).toBe(true)

    act(() => result.current.page.cancelEdit())
    expect(result.current.page.selectedId).toBe('g1')
    expect(result.current.page.isEditing).toBe(false)
  })

  it('holds leaving the edit form while it has unsaved edits', () => {
    const { result } = renderState()
    act(() => result.current.page.edit('g1'))
    act(() => result.current.page.patch({ dirty: true }))

    act(() => result.current.page.cancelEdit())
    expect(result.current.page.isEditing).toBe(true)
    expect(result.current.page.pendingSelection).toEqual({ id: 'g1', editing: false })
  })

  it('treats a new item as a form, and closes the panel when its form is cancelled', () => {
    const { result } = renderState()
    act(() => result.current.page.select('new'))
    expect(result.current.page.isEditing).toBe(true)

    act(() => result.current.page.cancelEdit())
    expect(result.current.page.selectedId).toBeNull()
  })
})
