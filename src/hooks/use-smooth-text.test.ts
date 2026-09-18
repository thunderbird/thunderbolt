/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, spyOn } from 'bun:test'
import { useSmoothText } from './use-smooth-text'

/** Advance the shared fake animation clock inside React's update boundary. */
const tick = (ms: number) => act(() => getClock().tick(ms))

describe('useSmoothText', () => {
  it('paces a burst, commits at 40ms cadence and releases idle/unmounted frames', () => {
    const { result, unmount } = renderHook(() => useSmoothText('a'.repeat(1000), true))
    expect(result.current).toBe('')
    tick(32)
    expect(result.current).toBe('')
    tick(16)
    expect(result.current.length).toBeGreaterThan(0)
    expect(result.current.length).toBeLessThan(1000)
    const prefix = result.current
    tick(32)
    expect(result.current).toBe(prefix)
    tick(1000)
    expect(result.current).toBe('a'.repeat(1000))
    expect(getClock().countTimers()).toBe(0)
    unmount()
    const active = renderHook(() => useSmoothText('b'.repeat(1000), true))
    expect(getClock().countTimers()).toBe(1)
    active.unmount()
    expect(getClock().countTimers()).toBe(0)
  })

  it('preserves elapsed time across continuous sub-frame appends', () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
      initialProps: { text: 'a'.repeat(2000) },
    })
    for (const elapsed of Array.from({ length: 1000 }, (_, index) => index + 1)) {
      tick(1)
      rerender({ text: 'a'.repeat(2000 + elapsed) })
    }
    expect(result.current.length).toBeGreaterThan(2600)
    expect(result.current.length).toBeLessThan(3000)
    tick(2000)
    expect(result.current).toBe('a'.repeat(3000))
  })

  it('restarts after idle without spending the long pause on newly arrived text', () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
      initialProps: { text: 'hello' },
    })
    tick(32)
    expect(result.current).toBe('hello')
    tick(10_000)
    rerender({ text: 'hello' + 'a'.repeat(100) })
    tick(16)
    expect(result.current).toBe('hello')
    tick(1000)
    expect(result.current).toBe('hello' + 'a'.repeat(100))
  })

  it.each(['a'.repeat(30), 'a'.repeat(30) + 'b'.repeat(370), ''])(
    'resets against the full previous target: %s',
    (replacement) => {
      const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
        initialProps: { text: 'a'.repeat(400) },
      })
      tick(48)
      rerender({ text: replacement })
      expect(result.current).toBe('')
      tick(2000)
      expect(result.current).toBe(replacement)
    },
  )

  it('shows complete text immediately for history and every terminal streaming transition', () => {
    const { result, rerender } = renderHook(({ text, enabled }) => useSmoothText(text, enabled), {
      initialProps: { text: 'history', enabled: false },
    })
    expect(result.current).toBe('history')
    expect(getClock().countTimers()).toBe(0)
    rerender({ text: 'new'.repeat(100), enabled: true })
    tick(48)
    rerender({ text: 'final'.repeat(100), enabled: false })
    expect(result.current).toBe('final'.repeat(100))
    expect(getClock().countTimers()).toBe(0)
  })

  it('only exposes whole emoji and combining graphemes', () => {
    const clusters = ['👨‍👩‍👧‍👦', 'e\u0301', '🇧🇷', '👍🏽']
    const text = clusters.join('').repeat(10)
    const boundaries = new Set([
      '',
      ...Array.from({ length: 40 }, (_, index) =>
        Array.from({ length: index + 1 }, (_, cluster) => clusters[cluster % clusters.length]).join(''),
      ),
    ])
    const { result } = renderHook(() => useSmoothText(text, true))
    for (const _ of Array.from({ length: 100 })) {
      tick(16)
      expect(boundaries.has(result.current)).toBe(true)
    }
    expect(result.current).toBe(text)
  })

  it('flushes when reduced motion changes and reveals later appends without animation', () => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listeners = new Set<() => void>()
    const preference = { matches: false }
    const matchMedia = spyOn(window, 'matchMedia').mockImplementation(() => ({
      ...media,
      get matches() {
        return preference.matches
      },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.add(listener as () => void),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.delete(listener as () => void),
    }))
    try {
      const { result, rerender, unmount } = renderHook(({ text }) => useSmoothText(text, true), {
        initialProps: { text: 'a'.repeat(1000) },
      })
      tick(48)
      act(() => {
        preference.matches = true
        listeners.forEach((listener) => listener())
      })
      expect(result.current).toBe('a'.repeat(1000))
      expect(getClock().countTimers()).toBe(0)
      rerender({ text: 'a'.repeat(1100) })
      expect(result.current).toBe('a'.repeat(1100))
      unmount()
      expect(listeners.size).toBe(0)
    } finally {
      matchMedia.mockRestore()
    }
  })
})

it('restarts when an append is batched with the frame that caught up', () => {
  const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
    initialProps: { text: 'hello' },
  })
  act(() => {
    getClock().tick(32)
    rerender({ text: 'hello world' })
  })
  tick(1000)
  expect(result.current).toBe('hello world')
})

it('catches up after legacy 10ms word deliveries without changing the delivered source', () => {
  const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), { initialProps: { text: '' } })
  for (const words of Array.from({ length: 100 }, (_, index) => index + 1)) {
    tick(10)
    rerender({ text: 'word '.repeat(words) })
  }
  expect(result.current.length).toBeGreaterThan(350)
  expect(result.current.length).toBeLessThan(500)
  const measurement = { displayedAtDeliveryEnd: result.current.length, catchUpMs: 0 }
  while (result.current.length < 500 && measurement.catchUpMs < 1000) {
    tick(16)
    measurement.catchUpMs += 16
  }
  expect(measurement.catchUpMs).toBeGreaterThan(250)
  expect(measurement.catchUpMs).toBeLessThan(600)
  expect(result.current).toBe('word '.repeat(100))
})
