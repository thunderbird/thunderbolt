import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useDraftInput } from './use-draft-input'

const fakeTimers = () => {
  let time = 0
  const timers: Array<{ id: number; callback: () => void; fireAt: number }> = []
  let nextId = 1

  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const id = nextId++
    timers.push({ id, callback, fireAt: time + ms })
    return id
  }) as unknown as typeof setTimeout

  globalThis.clearTimeout = ((id: number) => {
    const index = timers.findIndex((t) => t.id === id)
    if (index !== -1) {
      timers.splice(index, 1)
    }
  }) as unknown as typeof clearTimeout

  return {
    advance: (ms: number) => {
      time += ms
      const ready = timers.filter((t) => t.fireAt <= time)
      for (const t of ready) {
        timers.splice(timers.indexOf(t), 1)
        t.callback()
      }
    },
  }
}

describe('useDraftInput', () => {
  let originalSetTimeout: typeof setTimeout
  let originalClearTimeout: typeof clearTimeout

  beforeEach(() => {
    localStorage.clear()
    originalSetTimeout = globalThis.setTimeout
    originalClearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
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
    const timers = fakeTimers()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('hello')
    })

    // Not saved yet (debounce pending)
    expect(localStorage.getItem('draft:thread-1')).toBeNull()

    act(() => {
      timers.advance(300)
    })

    expect(localStorage.getItem('draft:thread-1')).toBe('hello')
  })

  it('debounces rapid typing', () => {
    const timers = fakeTimers()
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
      timers.advance(300)
    })

    // Only the last value should be saved
    expect(localStorage.getItem('draft:thread-1')).toBe('hel')
  })

  it('clears draft from localStorage', () => {
    const timers = fakeTimers()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('some text')
    })
    act(() => {
      timers.advance(300)
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
    const timers = fakeTimers()
    const { result } = renderHook(() => useDraftInput('thread-1'))

    act(() => {
      result.current[1]('')
    })
    act(() => {
      timers.advance(300)
    })

    expect(localStorage.getItem('draft:thread-1')).toBeNull()
  })

  it('flushes pending draft on thread switch', () => {
    fakeTimers()
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
