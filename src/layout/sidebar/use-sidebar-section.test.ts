/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useSidebarSection } from './use-sidebar-section'

describe('useSidebarSection', () => {
  it('derives the section from the route', () => {
    const { result: chats } = renderHook(() => useSidebarSection('/chats/123'))
    expect(chats.current.activeSection).toBe('chats')

    const { result: settings } = renderHook(() => useSidebarSection('/settings/models'))
    expect(settings.current.activeSection).toBe('settings')
  })

  it('lets the toggle override the route-derived section without navigating', () => {
    const { result } = renderHook(() => useSidebarSection('/chats/123'))

    act(() => result.current.setActiveSection('settings'))

    expect(result.current.activeSection).toBe('settings')
  })

  it('clears the override when toggling back to the route-derived section', () => {
    const { result } = renderHook(() => useSidebarSection('/settings/models'))

    act(() => result.current.setActiveSection('chats'))
    expect(result.current.activeSection).toBe('chats')

    act(() => result.current.setActiveSection('settings'))
    expect(result.current.activeSection).toBe('settings')
  })

  it('invalidates the override on navigation — the section follows the new route', () => {
    const { result, rerender } = renderHook(({ pathname }) => useSidebarSection(pathname), {
      initialProps: { pathname: '/chats/123' },
    })

    act(() => result.current.setActiveSection('settings'))
    expect(result.current.activeSection).toBe('settings')

    // Any navigation invalidates the override — it must not leak onto the
    // new page.
    rerender({ pathname: '/chats/456' })
    expect(result.current.activeSection).toBe('chats')
  })

  it('keeps the override while staying on the same pathname', () => {
    const { result, rerender } = renderHook(({ pathname }) => useSidebarSection(pathname), {
      initialProps: { pathname: '/chats/123' },
    })

    act(() => result.current.setActiveSection('settings'))
    rerender({ pathname: '/chats/123' })

    expect(result.current.activeSection).toBe('settings')
  })
})
