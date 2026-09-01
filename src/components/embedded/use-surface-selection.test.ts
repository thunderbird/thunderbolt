/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'

import type { SurfaceRect, SurfaceSelectionItem } from './types'
import { useSurfaceSelection } from './use-surface-selection'

const rect: SurfaceRect = { x: 0, y: 0, width: 100, height: 40 }
const row = (id: string): SurfaceSelectionItem => ({ id, label: `Row ${id}`, text: `text ${id}` })

/** A query the test resolves by hand, so `resolving` can be observed. */
const deferredQuery = () => {
  let release: (items: SurfaceSelectionItem[]) => void = () => {}
  const query = () => new Promise<SurfaceSelectionItem[]>((resolve) => (release = resolve))
  return { query, release: (items: SurfaceSelectionItem[]) => release(items) }
}

const setup = (query: (rect: SurfaceRect) => Promise<SurfaceSelectionItem[]>) => {
  const asked: string[][] = []
  const hook = renderHook(() => useSurfaceSelection({ query, onAsk: (passages) => asked.push(passages) }))
  return { hook, asked }
}

describe('useSurfaceSelection', () => {
  it('starts idle', () => {
    const { hook } = setup(async () => [])
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  /**
   * The Mini App copy dropped out of drawing *before* awaiting the guest, so for
   * up to the query timeout the dim vanished, the floating buttons popped back
   * and a stale popover could reappear — it read as "my drag did nothing".
   */
  it('stays occupied while the guest is still answering', async () => {
    const { query, release } = deferredQuery()
    const { hook } = setup(query)

    act(() => hook.result.current.startMarquee())
    expect(hook.result.current.mode.kind).toBe('drawing')

    act(() => void hook.result.current.resolveMarquee(rect))
    expect(hook.result.current.mode.kind).toBe('resolving')

    await act(async () => release([row('a')]))
    expect(hook.result.current.mode.kind).toBe('reviewing')
  })

  it('treats an empty answer as a real answer, not a failure', async () => {
    const { hook } = setup(async () => [])

    act(() => hook.result.current.startMarquee())
    await act(async () => await hook.result.current.resolveMarquee(rect))

    expect(hook.result.current.mode).toEqual({ kind: 'reviewing', items: [] })
  })

  /**
   * The two-flag version this replaces let a result bar sit pinned over an
   * active marquee, which is why "Try again" needed a hand-written reset.
   */
  it('cannot be reviewing and drawing at once', async () => {
    const { hook } = setup(async () => [])

    act(() => hook.result.current.startMarquee())
    await act(async () => await hook.result.current.resolveMarquee(rect))
    act(() => hook.result.current.startMarquee())

    expect(hook.result.current.mode.kind).toBe('drawing')
  })

  /** A late answer to a cancelled drag must not resurrect the review bar. */
  it('discards an answer that arrives after the user gave up', async () => {
    const { query, release } = deferredQuery()
    const { hook } = setup(query)

    act(() => hook.result.current.startMarquee())
    act(() => void hook.result.current.resolveMarquee(rect))
    act(() => hook.result.current.dismiss())

    await act(async () => release([row('a')]))
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  it('sends the selection to the composer and closes', async () => {
    const { hook, asked } = setup(async () => [row('a')])

    act(() => hook.result.current.startMarquee())
    await act(async () => await hook.result.current.resolveMarquee(rect))
    act(() => hook.result.current.askAboutItems([row('a')]))

    expect(asked).toEqual([['Row a\ntext a']])
    expect(hook.result.current.mode.kind).toBe('idle')
  })

  /**
   * Both surfaces now share `toSelectionPassages`. The artifact side used to do
   * a naive `label\ntext` join, so a thirty-row marquee buried the composer in
   * thirty chips while the same gesture in a Mini App produced one.
   */
  it('collapses a wide selection into a single passage', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map(row)
    const { hook, asked } = setup(async () => many)

    act(() => hook.result.current.startMarquee())
    await act(async () => await hook.result.current.resolveMarquee(rect))
    act(() => hook.result.current.askAboutItems(many))

    expect(asked[0]).toHaveLength(1)
    expect(asked[0]?.[0]).toContain('5 selected items')
  })
})
