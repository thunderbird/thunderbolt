import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useLocalStorage } from './use-local-storage'

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

describe('useLocalStorage', () => {
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

  describe('immediate mode (no debounce)', () => {
    it('returns default value when key is absent', () => {
      const { result } = renderHook(() => useLocalStorage('test-key', 'default'))
      expect(result.current[0]).toBe('default')
    })

    it('returns stored value when key exists', () => {
      localStorage.setItem('test-key', 'stored')
      const { result } = renderHook(() => useLocalStorage('test-key', 'default'))
      expect(result.current[0]).toBe('stored')
    })

    it('writes to localStorage immediately', () => {
      const { result } = renderHook(() => useLocalStorage('test-key', ''))
      act(() => {
        result.current[1]('hello')
      })
      expect(localStorage.getItem('test-key')).toBe('hello')
    })

    it('removes key when value matches default', () => {
      localStorage.setItem('test-key', 'something')
      const { result } = renderHook(() => useLocalStorage('test-key', ''))
      act(() => {
        result.current[1]('')
      })
      expect(localStorage.getItem('test-key')).toBeNull()
    })
  })

  describe('debounced mode', () => {
    it('does not write until debounce fires', () => {
      const timers = fakeTimers()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('hello')
      })
      expect(localStorage.getItem('test-key')).toBeNull()

      act(() => {
        timers.advance(300)
      })
      expect(localStorage.getItem('test-key')).toBe('hello')
    })

    it('debounces rapid updates', () => {
      const timers = fakeTimers()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('a')
      })
      act(() => {
        result.current[1]('ab')
      })
      act(() => {
        result.current[1]('abc')
      })

      act(() => {
        timers.advance(300)
      })
      expect(localStorage.getItem('test-key')).toBe('abc')
    })

    it('writes immediately when immediate option is set', () => {
      fakeTimers()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('immediate value', { immediate: true })
      })
      expect(localStorage.getItem('test-key')).toBe('immediate value')
    })

    it('cancels pending debounce when immediate write is called', () => {
      const timers = fakeTimers()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('debounced')
      })
      expect(localStorage.getItem('test-key')).toBeNull()

      act(() => {
        result.current[1]('final', { immediate: true })
      })
      expect(localStorage.getItem('test-key')).toBe('final')

      // Advancing should not overwrite with the old debounced value
      act(() => {
        timers.advance(300)
      })
      expect(localStorage.getItem('test-key')).toBe('final')
    })

    it('removes key when debounced value matches default', () => {
      localStorage.setItem('test-key', 'old')
      const timers = fakeTimers()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('')
      })
      act(() => {
        timers.advance(300)
      })
      expect(localStorage.getItem('test-key')).toBeNull()
    })

    it('flushes pending write on key change', () => {
      fakeTimers()
      const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, '', { debounceMs: 300 }), {
        initialProps: { key: 'key-1' },
      })

      act(() => {
        result.current[1]('pending value')
      })

      // Key changes before debounce fires
      rerender({ key: 'key-2' })

      // Pending value for key-1 should have been flushed
      expect(localStorage.getItem('key-1')).toBe('pending value')
    })
  })

  describe('key changes', () => {
    it('loads new value when key changes', () => {
      localStorage.setItem('key-1', 'value one')
      localStorage.setItem('key-2', 'value two')

      const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, ''), {
        initialProps: { key: 'key-1' },
      })

      expect(result.current[0]).toBe('value one')

      rerender({ key: 'key-2' })

      expect(result.current[0]).toBe('value two')
    })

    it('returns default when new key has no stored value', () => {
      localStorage.setItem('key-1', 'value one')

      const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, 'fallback'), {
        initialProps: { key: 'key-1' },
      })

      expect(result.current[0]).toBe('value one')

      rerender({ key: 'key-2' })

      expect(result.current[0]).toBe('fallback')
    })
  })
})
