/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { useDraftInput } from './use-draft-input'

describe('useDraftInput', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('initializes with empty string when no draft exists', () => {
    const { result } = renderHook(() => useDraftInput('thread-1'))
    expect(result.current[0]).toBe('')
  })

  it('initializes with saved draft from localStorage', () => {
    localStorage.setItem('draft:thread-1', 'saved text')
    const { result } = renderHook(() => useDraftInput('thread-1'))
    expect(result.current[0]).toBe('saved text')
  })

  it('saves draft to localStorage after debounce', () => {
    const clock = getClock()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('hello')
    })

    // Not saved yet (debounce pending)
    expect(localStorage.getItem('draft:thread-1')).toBeNull()

    act(() => {
      clock.tick(300)
    })

    expect(localStorage.getItem('draft:thread-1')).toBe('hello')
  })

  it('debounces rapid typing', () => {
    const clock = getClock()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('h')
    })
    act(() => {
      result.current[1]('he')
    })
    act(() => {
      result.current[1]('hel')
    })

    act(() => {
      clock.tick(300)
    })

    // Only the last value should be saved
    expect(localStorage.getItem('draft:thread-1')).toBe('hel')
  })

  it('clears draft from localStorage', () => {
    const clock = getClock()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('some text')
    })
    act(() => {
      clock.tick(300)
    })
    expect(localStorage.getItem('draft:thread-1')).toBe('some text')

    act(() => {
      result.current[2]()
    })

    expect(result.current[0]).toBe('')
    expect(localStorage.getItem('draft:thread-1')).toBeNull()
  })

  it('removes key when draft is set to empty string', () => {
    localStorage.setItem('draft:thread-1', 'old')
    const clock = getClock()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('')
    })
    act(() => {
      clock.tick(300)
    })

    expect(localStorage.getItem('draft:thread-1')).toBeNull()
  })

  it('flushes pending draft on thread switch', () => {
    const { result, rerender } = renderHook(({ id }) => useDraftInput(id), {
      initialProps: { id: 'thread-1' },
    })

    act(() => {
      result.current[1]('unsaved text')
    })

    // Switch threads before debounce fires
    rerender({ id: 'thread-2' })

    // The pending draft for thread-1 should have been flushed
    expect(localStorage.getItem('draft:thread-1')).toBe('unsaved text')
  })

  it('does not persist to localStorage when persist is false', () => {
    const clock = getClock()
    const { result } = renderHook(() => useDraftInput('new', { persist: false }))

    act(() => {
      result.current[1]('hello')
    })
    act(() => {
      clock.tick(300)
    })

    expect(result.current[0]).toBe('hello')
    expect(localStorage.getItem('draft:new')).toBeNull()
  })

  it('does not load from localStorage when persist is false', () => {
    localStorage.setItem('draft:new', 'stale draft')
    const { result } = renderHook(() => useDraftInput('new', { persist: false }))
    expect(result.current[0]).toBe('')
  })

  it('loads correct draft when chatThreadId changes', () => {
    localStorage.setItem('draft:thread-1', 'draft one')
    localStorage.setItem('draft:thread-2', 'draft two')

    const { result, rerender } = renderHook(({ id }) => useDraftInput(id), {
      initialProps: { id: 'thread-1' },
    })

    expect(result.current[0]).toBe('draft one')

    rerender({ id: 'thread-2' })

    expect(result.current[0]).toBe('draft two')
  })
})
