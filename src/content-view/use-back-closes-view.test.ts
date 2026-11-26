/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { useBackClosesView } from './use-back-closes-view'

const routeState = { usr: null, key: 'chat', idx: 3 }

const renderBackClosesView = (open: boolean) => {
  const onBack = mock(() => {})
  const view = renderHook(({ isOpen }) => useBackClosesView(isOpen, onBack), { initialProps: { isOpen: open } })
  return { ...view, onBack }
}

describe('useBackClosesView', () => {
  beforeEach(() => {
    window.history.replaceState(routeState, '')
  })

  afterEach(() => mock.restore())

  test('opening adds one entry that keeps the route state, and Back closes without leaving the route', () => {
    const before = window.history.length
    const { onBack } = renderBackClosesView(true)

    expect(window.history.length).toBe(before + 1)
    expect(window.history.state).toEqual({ ...routeState, contentViewOpen: true })

    act(() => window.history.back())

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(window.history.state).toEqual(routeState)
  })

  test('closing without Back removes the entry, so the next Back acts as before', () => {
    const { rerender, onBack } = renderBackClosesView(true)

    rerender({ isOpen: false })

    expect(window.history.state).toEqual(routeState)
    expect(onBack).not.toHaveBeenCalled()
  })

  test('staying open, remounting or reopening on a leftover entry never stacks a second one', () => {
    const before = window.history.length
    const first = renderBackClosesView(true)
    first.rerender({ isOpen: true })
    first.unmount()
    renderBackClosesView(true)

    expect(window.history.length).toBe(before + 1)
  })

  test('reopening before the close has popped its entry keeps the new view open, and Back still closes it', () => {
    const { rerender, onBack } = renderBackClosesView(true)
    // A browser traverses after history.back() returns; hold the traversal until the view has reopened.
    const back = window.history.back.bind(window.history)
    const heldBack = spyOn(window.history, 'back').mockImplementation(() => {})

    rerender({ isOpen: false })
    rerender({ isOpen: true })
    rerender({ isOpen: false })
    rerender({ isOpen: true })
    expect(heldBack).toHaveBeenCalledTimes(1)
    heldBack.mockRestore()
    act(() => back())

    expect(onBack).not.toHaveBeenCalled()
    expect(window.history.state).toEqual({ ...routeState, contentViewOpen: true })

    act(() => window.history.back())

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(window.history.state).toEqual(routeState)
  })

  test('an entry left under a route change made while the view was open costs no extra Back', () => {
    const { rerender, onBack } = renderBackClosesView(true)
    const otherChat = { usr: null, key: 'other-chat', idx: 4 }
    act(() => window.history.pushState(otherChat, ''))

    rerender({ isOpen: false })
    expect(window.history.state).toEqual(otherChat)

    act(() => window.history.back())

    expect(window.history.state).toEqual(routeState)
    expect(onBack).not.toHaveBeenCalled()
  })

  test('after Back closes the view, Forward does not land on its dead entry', () => {
    const { rerender, onBack } = renderBackClosesView(true)
    act(() => window.history.back())
    rerender({ isOpen: false })

    act(() => window.history.forward())

    expect(window.history.state).toEqual(routeState)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('a closed view leaves history alone', () => {
    const before = window.history.length
    const { onBack } = renderBackClosesView(false)

    act(() => window.history.pushState({ ...routeState, idx: 4 }, ''))
    act(() => window.history.back())

    expect(window.history.length).toBe(before + 1)
    expect(window.history.state).toEqual(routeState)
    expect(onBack).not.toHaveBeenCalled()
  })
})
