/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

import { CreateItemProvider, useCreateItem } from './context'

const wrapper = ({ children }: { children: ReactNode }) => <CreateItemProvider>{children}</CreateItemProvider>

describe('CreateItemProvider', () => {
  it('opens and closes a route-independent create request', () => {
    const { result } = renderHook(useCreateItem, { wrapper })

    act(() => result.current.openCreateItem({ kind: 'model' }))
    expect(result.current.request).toEqual({ id: 1, kind: 'model' })
    expect(result.current.isSurfaceOpen).toBe(false)

    // Two frames: the open state flips on the second rAF (see openCreateItem).
    act(() => getClock().tick(32))
    expect(result.current.isSurfaceOpen).toBe(true)

    act(() => result.current.closeCreateItem())
    expect(result.current.request).toBeNull()
    expect(result.current.isSurfaceOpen).toBe(false)
  })

  it('assigns a new id when the same form is reopened', () => {
    const { result } = renderHook(useCreateItem, { wrapper })

    act(() => result.current.openCreateItem({ kind: 'skill', initialName: 'daily-brief' }))
    const firstId = result.current.request?.id
    act(() => result.current.closeCreateItem())
    act(() => result.current.openCreateItem({ kind: 'skill' }))

    expect(result.current.request).toEqual({ id: 2, kind: 'skill' })
    expect(result.current.request?.id).not.toBe(firstId)
    act(() => getClock().tick(32))
    expect(result.current.isSurfaceOpen).toBe(true)
  })
})
