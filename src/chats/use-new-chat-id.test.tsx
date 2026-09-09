/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-854. The id minted for `/chats/new` is what the route keys on, so these
 * tests are really about when the chat subtree remounts — and, more to the
 * point, when it must not.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useNewChatId } from './detail'

/** Mirrors the route: `/chats/new` → isNew true, `/chats/<id>` → false. */
const renderRoute = (isNew: boolean, projectId: string | null = null) =>
  renderHook(({ isNew: n, projectId: p }) => useNewChatId(n, p), { initialProps: { isNew, projectId } })

describe('useNewChatId', () => {
  it('holds one id steady while the user composes at /chats/new', () => {
    const { result, rerender } = renderRoute(true)
    const first = result.current

    rerender({ isNew: true, projectId: null })
    expect(result.current).toBe(first)
  })

  /**
   * The regression itself. The first send persists the thread and navigates to
   * `/chats/<this id>`; the route keys on the id in both states, so holding it
   * across the transition is what stops the subtree remounting — which used to
   * tear down the live voice session mid-turn and swallow the spoken reply.
   */
  it('keeps the same id when the first send navigates to /chats/<id>', () => {
    const { result, rerender } = renderRoute(true)
    const minted = result.current

    rerender({ isNew: false, projectId: null })

    expect(result.current).toBe(minted)
  })

  it('mints a fresh id when the user starts another new chat', () => {
    const { result, rerender } = renderRoute(true)
    const first = result.current

    rerender({ isNew: false, projectId: null }) // first send navigates away
    rerender({ isNew: true, projectId: null }) // "New chat"

    expect(result.current).not.toBe(first)
  })

  /**
   * Without this, `/chats/new?projectId=X` → `/chats/new` would reuse the id and
   * file the first message under the project the user had just left.
   */
  it('mints a fresh id when the project changes at /chats/new', () => {
    const { result, rerender } = renderRoute(true, 'project-a')
    const inProjectA = result.current

    rerender({ isNew: true, projectId: 'project-b' })
    expect(result.current).not.toBe(inProjectA)

    rerender({ isNew: true, projectId: null })
    expect(result.current).not.toBe(inProjectA)
  })

  it('does not mint while moving between persisted chats', () => {
    const { result, rerender } = renderRoute(false)
    const idle = result.current

    rerender({ isNew: false, projectId: null })
    expect(result.current).toBe(idle)
  })
})
