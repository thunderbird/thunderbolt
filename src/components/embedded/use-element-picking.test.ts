/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'

import type { SurfaceHighlightedElement } from './types'
import { useElementPicking } from './use-element-picking'

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
  const hook = renderHook(() => useElementPicking({ query, onAsk: (passages) => asked.push(passages) }))
  return { hook, asked }
}

const point = { x: 10, y: 20 }

describe('useElementPicking', () => {
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

  it('takes the outlined element to the composer and leaves pick mode', async () => {
    const { hook, asked } = setup(async () => element('a'))
    act(() => hook.result.current.startPicking())
    await act(async () => {
      await hook.result.current.pointAt(point)
    })
    await act(async () => {
      await hook.result.current.pickAt(point)
    })

    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toContain('text a')
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  /**
   * Move, then click before the guest has answered — which is the ordinary case
   * at 60ms per query, not an edge one. The outline still shows the previous
   * element, so committing it would attach a passage for something the pointer
   * has left. The click resolves its own position instead.
   */
  it('does not commit a stale outline when a newer lookup is in flight', async () => {
    const { query, releases } = deferredQueries()
    const { hook, asked } = setup(query)
    act(() => hook.result.current.startPicking())

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = hook.result.current.pointAt(point)
    })
    await act(async () => {
      releases[0](element('a'))
      await first
    })

    // Pointer moves onto 'b'; that answer has not landed yet.
    act(() => {
      void hook.result.current.pointAt({ x: 90, y: 90 })
    })
    let picked: Promise<void> = Promise.resolve()
    act(() => {
      picked = hook.result.current.pickAt({ x: 90, y: 90 })
    })
    await act(async () => {
      // releases[1] is the in-flight move, releases[2] the click's own query.
      releases[1](element('b'))
      releases[2](element('b'))
      await picked
    })

    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toContain('text b')
  })

  /**
   * The mirror of "ignores an answer that lands after the user gave up", for the
   * commit path rather than the outline path. Escape while the click's own
   * lookup is in flight must not attach a passage — the gesture is over.
   */
  it('does not commit a pick the user cancelled while it was in flight', async () => {
    const { query, releases } = deferredQueries()
    const { hook, asked } = setup(query)
    act(() => hook.result.current.startPicking())

    // Move so the outline is stale, making the click take the awaiting path.
    act(() => {
      void hook.result.current.pointAt(point)
    })
    let picked: Promise<void> = Promise.resolve()
    act(() => {
      picked = hook.result.current.pickAt(point)
    })
    act(() => hook.result.current.dismiss())
    await act(async () => {
      releases.forEach((release) => release(element('a')))
      await picked
    })

    expect(asked).toEqual([])
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  /** Clicking background commits nothing and leaves picking on, rather than
   *  sending an empty passage. */
  it('ignores a click with nothing under it', async () => {
    const { hook, asked } = setup(async () => null)
    act(() => hook.result.current.startPicking())
    await act(async () => {
      await hook.result.current.pointAt(point)
    })
    await act(async () => {
      await hook.result.current.pickAt(point)
    })

    expect(asked).toEqual([])
    expect(hook.result.current.mode.kind).toBe('picking')
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
