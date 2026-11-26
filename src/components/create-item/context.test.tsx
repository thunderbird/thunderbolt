/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { type ReactNode, useState } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'

import { CreateItemProvider, useCreateItem } from './context'

const wrapper = ({ children }: { children: ReactNode }) => <CreateItemProvider>{children}</CreateItemProvider>

const RouteProvider = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation()
  return <CreateItemProvider pathname={pathname}>{children}</CreateItemProvider>
}

const routeWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/chats/new']}>
    <RouteProvider>{children}</RouteProvider>
  </MemoryRouter>
)

const useRoutedCreateItem = () => {
  const panel = useCreateItem()
  const navigate = useNavigate()
  const [pageDraft, setPageDraft] = useState('')
  return { ...panel, navigate, pageDraft, setPageDraft }
}

describe('CreateItemProvider', () => {
  it('opens and closes a create request in place', () => {
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

  it.each([{ kind: 'model' }, { kind: 'agent' }, { kind: 'skill' }, { kind: 'connection' }] as const)(
    'retires a %j panel on navigation without resurrecting it on Back',
    (request) => {
      const { result } = renderHook(useRoutedCreateItem, { wrapper: routeWrapper })
      act(() => {
        result.current.setPageDraft('Keep the surrounding page mounted')
        result.current.openCreateItem(request)
      })
      act(() => getClock().tick(32))
      expect(result.current.isSurfaceOpen).toBe(true)

      act(() => result.current.navigate('/settings/models'))
      expect(result.current.request).toBeNull()
      expect(result.current.isSurfaceOpen).toBe(false)
      expect(result.current.pageDraft).toBe('Keep the surrounding page mounted')

      act(() => result.current.navigate(-1))
      expect(result.current.request).toBeNull()
      expect(result.current.isSurfaceOpen).toBe(false)
    },
  )

  it.each([0, 16])('does not reopen a retired panel when navigation interrupts frame %s', (elapsed) => {
    const { result } = renderHook(useRoutedCreateItem, { wrapper: routeWrapper })
    act(() => result.current.openCreateItem({ kind: 'model' }))
    act(() => getClock().tick(elapsed))
    act(() => result.current.navigate('/settings/models'))
    act(() => getClock().tick(64))
    expect(result.current.request).toBeNull()
    expect(result.current.isSurfaceOpen).toBe(false)
  })

  it('preserves a draft across same-page query, hash, and OAuth-state updates', () => {
    const { result } = renderHook(useRoutedCreateItem, { wrapper: routeWrapper })
    act(() => result.current.openCreateItem({ kind: 'connection' }))
    act(() => getClock().tick(32))
    const request = result.current.request

    act(() =>
      result.current.navigate('/chats/new?project=work#details', {
        replace: true,
        state: { connectionOAuthReturn: 'return-nonce' },
      }),
    )
    expect(result.current.request).toBe(request)
    expect(result.current.isSurfaceOpen).toBe(true)
  })

  it('ignores a completed save from a retired panel while its successor is opening', () => {
    const { result } = renderHook(useRoutedCreateItem, { wrapper: routeWrapper })
    act(() => result.current.openCreateItem({ kind: 'skill' }))
    const retiredId = result.current.request!.id
    act(() => result.current.navigate('/settings/models'))
    act(() => result.current.openCreateItem({ kind: 'model' }))
    const currentRequest = result.current.request
    act(() => result.current.closeCreateItem(retiredId))
    act(() => getClock().tick(32))

    expect(result.current.request).toBe(currentRequest)
    expect(result.current.isSurfaceOpen).toBe(true)
    act(() => result.current.closeCreateItem(currentRequest!.id))
    expect(result.current.request).toBeNull()
  })
})
