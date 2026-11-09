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
  const hook = renderHook(
    ({ documentKey }) => useElementPicking({ query, onAsk: (passages) => asked.push(passages), documentKey }),
    { initialProps: { documentKey: 1 } },
  )
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

  /*
   * Same rule, different way of leaving: the counter moved on a dismissal but
   * not when the page went away, so a hit-test answering after navigation still
   * matched its gesture and attached a passage for a pick the user had
   * abandoned — onto whatever conversation was current by then.
   */
  it('ignores an answer that lands after the page went away', async () => {
    const { query, releases } = deferredQueries()
    const { hook, asked } = setup(query)
    act(() => hook.result.current.startPicking())

    // Put an element on screen, then move again so the outline is stale — which
    // is the only path where `pickAt` awaits a fresh hit-test of its own.
    let firstMove: Promise<void> = Promise.resolve()
    act(() => {
      firstMove = hook.result.current.pointAt(point)
    })
    await act(async () => {
      releases[0](element('first'))
      await firstMove
    })
    act(() => {
      void hook.result.current.pointAt({ x: 99, y: 99 })
    })

    let inFlight: Promise<void> = Promise.resolve()
    act(() => {
      inFlight = hook.result.current.pickAt(point)
    })
    expect(releases).toHaveLength(3)

    hook.unmount()
    await act(async () => {
      releases[2](element('late'))
      await inFlight
    })

    expect(asked).toEqual([])
  })
})

describe('touch selection', () => {
  const tap = async (hook: ReturnType<typeof setup>['hook']) => {
    act(() => hook.result.current.startPicking())
    await act(async () => {
      await hook.result.current.selectAt(point)
    })
  }

  it('drops a tapped element when the document changes, so Add cannot quote the old page', async () => {
    const { hook, asked } = setup(async () => element('a'))
    await tap(hook)

    hook.rerender({ documentKey: 2 })

    expect(hook.result.current.mode.kind).toBe('picking')
    expect(hook.result.current.canConfirm).toBe(false)
    act(() => hook.result.current.confirmPick())
    expect(asked).toHaveLength(0)
  })

  it('discards an answer still in flight from the previous document', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())
    const pending = hook.result.current.selectAt(point)

    hook.rerender({ documentKey: 2 })
    await act(async () => {
      releases[0]?.(element('a'))
      await pending
    })

    expect(hook.result.current.canConfirm).toBe(false)
  })

  it('keeps a tapped element across renders of the same document', async () => {
    const { hook } = setup(async () => element('a'))
    await tap(hook)

    hook.rerender({ documentKey: 1 })

    expect(hook.result.current.canConfirm).toBe(true)
  })

  it('highlights a tapped element without attaching it', async () => {
    const { hook, asked } = setup(async () => element('a'))
    await tap(hook)

    expect(hook.result.current.canConfirm).toBe(true)
    expect(hook.result.current.mode.kind === 'picking' && hook.result.current.mode.element?.id).toBe('a')
    expect(asked).toHaveLength(0)
  })

  it('attaches the tapped element once confirmed and leaves picking', async () => {
    const { hook, asked } = setup(async () => element('a'))
    await tap(hook)
    act(() => hook.result.current.confirmPick())

    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toContain('text a')
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  it('offers no confirm for a tap on empty space', async () => {
    const { hook } = setup(async () => null)
    await tap(hook)

    expect(hook.result.current.canConfirm).toBe(false)
  })

  it('never makes a hovered element confirmable', async () => {
    const { hook, asked } = setup(async () => element('a'))
    act(() => hook.result.current.startPicking())
    await act(async () => {
      await hook.result.current.pointAt(point)
    })
    act(() => hook.result.current.confirmPick())

    expect(hook.result.current.canConfirm).toBe(false)
    expect(asked).toHaveLength(0)
  })

  it('does not confirm while a newer tap is being answered', async () => {
    const { query, releases } = deferredQueries()
    const { hook, asked } = setup(query)
    act(() => hook.result.current.startPicking())
    await act(async () => {
      const first = hook.result.current.selectAt(point)
      releases[0](element('a'))
      await first
    })
    act(() => {
      void hook.result.current.selectAt(point)
    })
    act(() => hook.result.current.confirmPick())

    expect(asked).toHaveLength(0)
  })

  it('steps back from a tapped element to choosing, then out of picking', async () => {
    const { hook, asked } = setup(async () => element('a'))
    await tap(hook)

    act(() => hook.result.current.stepBack())
    expect(hook.result.current.mode).toMatchObject({ kind: 'picking', element: null })
    expect(hook.result.current.canConfirm).toBe(false)

    act(() => hook.result.current.stepBack())
    expect(hook.result.current.mode.kind).toBe('idle')
    expect(asked).toHaveLength(0)
  })

  it('ignores an answer still in flight when the selection is cleared', async () => {
    const { query, releases } = deferredQueries()
    const { hook } = setup(query)
    act(() => hook.result.current.startPicking())
    await act(async () => {
      const first = hook.result.current.selectAt(point)
      releases[0](element('a'))
      await first
    })
    const late = hook.result.current.selectAt(point)
    act(() => hook.result.current.stepBack())
    await act(async () => {
      releases[1](element('b'))
      await late
    })

    expect(hook.result.current.mode).toMatchObject({ kind: 'picking', element: null })
    expect(hook.result.current.canConfirm).toBe(false)
  })

  it('attaches once when confirm fires twice', async () => {
    const { hook, asked } = setup(async () => element('a'))
    await tap(hook)
    act(() => {
      hook.result.current.confirmPick()
      hook.result.current.confirmPick()
    })

    expect(asked).toHaveLength(1)
  })
})

it('consumes an outlined pick synchronously before another click can reuse it', async () => {
  const { hook, asked } = setup(async () => element('a'))
  act(() => hook.result.current.startPicking())
  await act(async () => {
    await hook.result.current.pointAt(point)
  })
  await act(async () => {
    await Promise.all([hook.result.current.pickAt(point), hook.result.current.pickAt(point)])
  })
  expect(asked).toHaveLength(1)
})

it('consumes a gesture after the first pending click resolves', async () => {
  const { query, releases } = deferredQueries()
  const { hook, asked } = setup(query)
  act(() => hook.result.current.startPicking())
  act(() => {
    void hook.result.current.pointAt(point)
  })
  const first = hook.result.current.pickAt(point)
  const second = hook.result.current.pickAt(point)
  await act(async () => {
    releases[2](element('second'))
    await second
    releases[1](element('first'))
    releases[0](element('hover'))
    await first
  })
  expect(asked).toHaveLength(1)
  expect(asked[0][0]).toContain('text second')
})
