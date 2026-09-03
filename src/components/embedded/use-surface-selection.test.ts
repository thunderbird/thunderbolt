/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'

import type { SurfaceHighlightedElement } from './types'
import { useSurfaceSelection } from './use-surface-selection'

const element = (id: string): SurfaceHighlightedElement => ({
  id,
  label: `Row ${id}`,
  text: `text ${id}`,
  rect: { x: 0, y: 0, width: 100, height: 40 },
})

/** One deferred per call, so two in-flight queries can be settled out of order. */
const deferredQueries = () => {
  const releases: ((found: SurfaceHighlightedElement | null) => void)[] = []
  const query = () => new Promise<SurfaceHighlightedElement | null>((resolve) => releases.push(resolve))
  return { query, releases }
}

const setup = (query: (point: { x: number; y: number }) => Promise<SurfaceHighlightedElement | null>) => {
  const asked: string[][] = []
  const hook = renderHook(() => useSurfaceSelection({ query, onAsk: (passages) => asked.push(passages) }))
  return { hook, asked }
}

const point = { x: 10, y: 20 }

describe('useSurfaceSelection', () => {
  it('starts idle', () => {
    const { hook } = setup(async () => null)
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  it('enters picking with nothing highlighted yet', () => {
    const { hook } = setup(async () => null)
    act(() => hook.result.current.startPicking())

    expect(hook.result.current.mode).toMatchObject({ kind: 'picking', element: null })
  })

  it('shows what the guest found under the pointer', async () => {
    const { hook } = setup(async () => element('a'))
    act(() => hook.result.current.startPicking())
    await act(async () => {
      await hook.result.current.pointAt(point)
    })

    expect(hook.result.current.mode.kind === 'picking' && hook.result.current.mode.element?.id).toBe('a')
  })

  /*
   * A query rides every throttled pointer move, so answers arrive out of order
   * under load. Without the token guard the outline snaps back to a position the
   * pointer has already left.
   */
  it('ignores a stale answer that lands after a newer one', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())

    let first: Promise<void> = Promise.resolve()
    let second: Promise<void> = Promise.resolve()
    act(() => {
      first = hook.result.current.pointAt(point)
      second = hook.result.current.pointAt({ x: 80, y: 90 })
    })
    // Newest answers first, then the stale one.
    await act(async () => {
      releases[1](element('new'))
      releases[0](element('stale'))
      await first
      await second
    })

    expect(hook.result.current.mode.kind === 'picking' && hook.result.current.mode.element?.id).toBe('new')
  })

  /** Clearing on every move would strobe the outline as the cursor travels. */
  it('keeps the current outline while the next answer is in flight', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = hook.result.current.pointAt(point)
    })
    await act(async () => {
      releases[0](element('a'))
      await first
    })

    act(() => {
      void hook.result.current.pointAt({ x: 40, y: 50 })
    })
    expect(hook.result.current.mode.kind === 'picking' && hook.result.current.mode.element?.id).toBe('a')
  })

  /** Nothing under the pointer is a real answer, not a failure. */
  it('clears the outline when the guest finds nothing', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = hook.result.current.pointAt(point)
    })
    await act(async () => {
      releases[0](element('a'))
      await first
    })

    let second: Promise<void> = Promise.resolve()
    act(() => {
      second = hook.result.current.pointAt({ x: 1, y: 1 })
    })
    await act(async () => {
      releases[1](null)
      await second
    })

    expect(hook.result.current.mode.kind === 'picking' && hook.result.current.mode.element).toBeNull()
  })

  it('takes the picked element to the composer and leaves pick mode', () => {
    const { hook, asked } = setup(async () => element('a'))
    act(() => hook.result.current.startPicking())
    act(() => hook.result.current.askAboutElement(element('a')))

    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toContain('text a')
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  it('returns to idle when dismissed', () => {
    const { hook } = setup(async () => element('a'))
    act(() => hook.result.current.startPicking())
    act(() => hook.result.current.dismiss())

    expect(hook.result.current.mode.kind).toBe('idle')
  })

  /** A late answer must not drag the user back into a gesture they cancelled. */
  it('ignores an answer that lands after the user gave up', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())

    let inFlight: Promise<void> = Promise.resolve()
    act(() => {
      inFlight = hook.result.current.pointAt(point)
    })
    act(() => hook.result.current.dismiss())
    await act(async () => {
      releases[0](element('late'))
      await inFlight
    })

    expect(hook.result.current.mode.kind).toBe('idle')
  })
})
