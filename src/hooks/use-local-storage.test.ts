/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { useLocalStorage } from './use-local-storage'

describe('useLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear()
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
      const clock = getClock()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('hello')
      })
      expect(localStorage.getItem('test-key')).toBeNull()

      act(() => {
        clock.tick(300)
      })
      expect(localStorage.getItem('test-key')).toBe('hello')
    })

    it('debounces rapid updates', () => {
      const clock = getClock()
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
        clock.tick(300)
      })
      expect(localStorage.getItem('test-key')).toBe('abc')
    })

    it('writes immediately when immediate option is set', () => {
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('immediate value', { immediate: true })
      })
      expect(localStorage.getItem('test-key')).toBe('immediate value')
    })

    it('cancels pending debounce when immediate write is called', () => {
      const clock = getClock()
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
        clock.tick(300)
      })
      expect(localStorage.getItem('test-key')).toBe('final')
    })

    it('removes key when debounced value matches default', () => {
      localStorage.setItem('test-key', 'old')
      const clock = getClock()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300 }))

      act(() => {
        result.current[1]('')
      })
      act(() => {
        clock.tick(300)
      })
      expect(localStorage.getItem('test-key')).toBeNull()
    })

    it('flushes pending write on key change', () => {
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

  describe('disabled mode', () => {
    it('returns default value and ignores localStorage', () => {
      localStorage.setItem('test-key', 'stored')
      const { result } = renderHook(() => useLocalStorage('test-key', 'default', { disabled: true }))
      expect(result.current[0]).toBe('default')
    })

    it('updates state without writing to localStorage', () => {
      const { result } = renderHook(() => useLocalStorage('test-key', '', { disabled: true }))
      act(() => {
        result.current[1]('hello')
      })
      expect(result.current[0]).toBe('hello')
      expect(localStorage.getItem('test-key')).toBeNull()
    })

    it('does not write to localStorage even with debounce', () => {
      const clock = getClock()
      const { result } = renderHook(() => useLocalStorage('test-key', '', { debounceMs: 300, disabled: true }))
      act(() => {
        result.current[1]('hello')
      })
      act(() => {
        clock.tick(300)
      })
      expect(result.current[0]).toBe('hello')
      expect(localStorage.getItem('test-key')).toBeNull()
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
