/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { useAutoScroll } from './use-auto-scroll'
import type { TouchEvent, WheelEvent } from 'react'

describe('useAutoScroll', () => {
  afterEach(() => {
    cleanup()
  })

  const createMockContainer = (scrollTop = 0, scrollHeight = 1000, clientHeight = 500) => {
    let _scrollTop = scrollTop
    const div = document.createElement('div')
    Object.defineProperties(div, {
      scrollTop: {
        get: () => _scrollTop,
        set: (val) => {
          _scrollTop = val
        },
        configurable: true,
      },
      scrollHeight: { value: scrollHeight, configurable: true },
      clientHeight: { value: clientHeight, configurable: true },
    })
    return div
  }

  const createMockTarget = () => document.createElement('div')

  // Helper to set up refs (callback refs need to be called)
  const setupRefs = (
    result: { current: ReturnType<typeof useAutoScroll> },
    container: HTMLDivElement,
    target: HTMLDivElement,
  ) => {
    act(() => {
      result.current.scrollContainerRef(container)
      result.current.scrollTargetRef(target)
    })
  }

  // Dependency-driven auto-scroll is coalesced into a requestAnimationFrame, so tests must
  // flush a frame to observe the scroll (fake timers fake requestAnimationFrame).
  const flushFrame = () => {
    act(() => {
      getClock().tick(16)
    })
  }

  describe('initialization', () => {
    it('should return all required refs and handlers', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(result.current).toHaveProperty('scrollContainerRef')
      expect(result.current).toHaveProperty('scrollTargetRef')
      expect(result.current).toHaveProperty('isAtBottom')
      expect(result.current).toHaveProperty('scrollToBottom')
      expect(result.current).toHaveProperty('resetUserScroll')
      expect(result.current).toHaveProperty('scrollHandlers')
    })

    it('should initialize with isAtBottom as true', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(result.current.isAtBottom).toBe(true)
    })

    it('should return scroll handlers with onWheel and onTouchStart', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(typeof result.current.scrollHandlers.onWheel).toBe('function')
      expect(typeof result.current.scrollHandlers.onTouchStart).toBe('function')
    })

    it('should return callback refs', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(typeof result.current.scrollContainerRef).toBe('function')
      expect(typeof result.current.scrollTargetRef).toBe('function')
    })
  })

  describe('scrollToBottom', () => {
    it('should scroll container to bottom with instant scroll', () => {
      const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      act(() => {
        result.current.scrollToBottom(false)
      })

      expect(container.scrollTop).toBe(500) // scrollHeight - clientHeight
    })

    it('should use instant scroll when isStreaming is true', () => {
      const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      act(() => {
        result.current.scrollToBottom()
      })

      expect(container.scrollTop).toBe(500)
    })

    it('should not throw when scrollToBottom is called with smooth option', () => {
      const { result } = renderHook(() => useAutoScroll({ smooth: true, isStreaming: false }))

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      expect(() => {
        act(() => {
          result.current.scrollToBottom()
        })
      }).not.toThrow()
    })
  })

  describe('handleWheel', () => {
    it('should disable auto-scroll when scrolling up', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(500, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      // Enable auto-scroll first
      act(() => {
        result.current.resetUserScroll()
      })

      // Scroll up (disables auto-scroll)
      act(() => {
        result.current.scrollHandlers.onWheel({ deltaY: -100 } as WheelEvent)
      })

      const scrollTopBefore = container.scrollTop

      // Change dependencies - should NOT auto-scroll since user scrolled up
      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()

      expect(container.scrollTop).toBe(scrollTopBefore)
    })

    it('should not disable auto-scroll when scrolling down', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      // Enable auto-scroll
      act(() => {
        result.current.resetUserScroll()
      })

      // Scroll down (should NOT disable auto-scroll)
      act(() => {
        result.current.scrollHandlers.onWheel({ deltaY: 100 } as WheelEvent)
      })

      // Change dependencies - should still auto-scroll (after the coalescing frame)
      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()

      expect(container.scrollTop).toBe(500)
    })
  })

  describe('handleTouchStart', () => {
    it('should disable auto-scroll on any touch (user wants control)', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(500, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      // Enable auto-scroll
      act(() => {
        result.current.resetUserScroll()
      })

      // Touch - should disable auto-scroll immediately (user wants control)
      act(() => {
        result.current.scrollHandlers.onTouchStart({} as TouchEvent)
      })

      const scrollTopBefore = container.scrollTop

      // Change dependencies - should NOT auto-scroll since user touched
      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()

      expect(container.scrollTop).toBe(scrollTopBefore)
    })
  })
  describe('resetUserScroll', () => {
    it('should enable auto-scroll when called', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      // Auto-scroll is disabled by default, so changing deps won't scroll
      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()
      expect(container.scrollTop).toBe(0)

      // Enable auto-scroll
      act(() => {
        result.current.resetUserScroll()
      })

      // Now changing deps should scroll (after the coalescing frame)
      act(() => {
        rerender({ deps: ['c'] })
      })
      flushFrame()
      expect(container.scrollTop).toBe(500)
    })
  })

  describe('dependency-based scrolling', () => {
    it('should not auto-scroll by default when dependencies change', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      const scrollTopBefore = container.scrollTop

      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()

      expect(container.scrollTop).toBe(scrollTopBefore)
    })

    it('should auto-scroll when enabled and dependencies change', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(0, 1000, 500)
      const target = createMockTarget()
      setupRefs(result, container, target)

      // Enable auto-scroll
      act(() => {
        result.current.resetUserScroll()
      })

      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()

      expect(container.scrollTop).toBe(500)
    })
  })

  describe('programmatic scroll flag', () => {
    describe('parameter behavior', () => {
      it('sets flag when programmatic=true', () => {
        const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Call with programmatic=true
        act(() => {
          result.current.scrollToBottom(false, true)
        })

        // Verify scroll happened
        expect(container.scrollTop).toBe(500)
      })

      it('does not set flag when programmatic=false', () => {
        const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Call with programmatic=false
        act(() => {
          result.current.scrollToBottom(false, false)
        })

        // Verify scroll happened
        expect(container.scrollTop).toBe(500)
      })

      it('does not set flag when programmatic is undefined (default)', () => {
        const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Call without programmatic parameter
        act(() => {
          result.current.scrollToBottom(false)
        })

        // Verify scroll happened
        expect(container.scrollTop).toBe(500)
      })
    })

    describe('timing and cleanup', () => {
      it('clears old timeout before setting new one on rapid scrolls', () => {
        const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // First programmatic scroll
        act(() => {
          result.current.scrollToBottom(false, true)
        })

        // Second programmatic scroll before timeout fires
        act(() => {
          result.current.scrollToBottom(false, true)
        })

        // Both scrolls should succeed without errors
        expect(container.scrollTop).toBe(500)
      })

      it('clears timeout on unmount', () => {
        const { result, unmount } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Trigger programmatic scroll
        act(() => {
          result.current.scrollToBottom(false, true)
        })

        // Unmount before timeout fires
        expect(() => unmount()).not.toThrow()
      })

      it('clears flag after 100ms for instant scrolls', async () => {
        const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Trigger instant programmatic scroll
        act(() => {
          result.current.scrollToBottom(false, true)
        })

        expect(container.scrollTop).toBe(500)

        // Advance time by 100ms to trigger flag clearing
        await act(async () => {
          await getClock().tickAsync(100)
        })

        // Flag should be cleared now (we can't directly test the ref, but verify no errors)
        expect(container.scrollTop).toBe(500)
      })

      it('does not throw when using smooth scroll with programmatic flag', () => {
        const { result } = renderHook(() => useAutoScroll({ smooth: true, isStreaming: false }))

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        // Trigger smooth programmatic scroll - should not throw
        expect(() => {
          act(() => {
            result.current.scrollToBottom(true, true)
          })
        }).not.toThrow()
      })
    })
  })

  describe('coalesced auto-scroll', () => {
    // Container that records every scrollTop write so coalescing can be asserted.
    const createCountingContainer = (scrollHeight = 1000, clientHeight = 500) => {
      const writes: number[] = []
      let value = 0
      const div = document.createElement('div')
      Object.defineProperties(div, {
        scrollTop: {
          get: () => value,
          set: (val: number) => {
            value = val
            writes.push(val)
          },
          configurable: true,
        },
        scrollHeight: { value: scrollHeight, configurable: true },
        clientHeight: { value: clientHeight, configurable: true },
      })
      return { div, writes }
    }

    it('collapses many dependency changes within one frame into a single scroll', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const { div, writes } = createCountingContainer()
      const target = createMockTarget()
      setupRefs(result, div, target)

      act(() => {
        result.current.resetUserScroll()
      })
      writes.length = 0

      // A burst of dependency changes (simulating many streamed tokens in one frame).
      act(() => {
        rerender({ deps: ['b'] })
        rerender({ deps: ['c'] })
        rerender({ deps: ['d'] })
      })

      // Nothing scrolls synchronously — the scroll is deferred to the animation frame.
      expect(writes.length).toBe(0)

      flushFrame()

      // The whole burst collapsed into exactly one scroll for the frame.
      expect(writes.length).toBe(1)
      expect(div.scrollTop).toBe(500)
    })

    it('schedules a fresh scroll for dependency changes in a later frame', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const { div, writes } = createCountingContainer()
      const target = createMockTarget()
      setupRefs(result, div, target)

      act(() => {
        result.current.resetUserScroll()
      })
      writes.length = 0

      act(() => {
        rerender({ deps: ['b'] })
      })
      flushFrame()
      expect(writes.length).toBe(1)

      act(() => {
        rerender({ deps: ['c'] })
      })
      flushFrame()
      expect(writes.length).toBe(2)
    })

    it('does not scroll on unmount even if a frame was pending', () => {
      const { result, rerender, unmount } = renderHook(
        ({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }),
        { initialProps: { deps: ['a'] } },
      )

      const { div, writes } = createCountingContainer()
      const target = createMockTarget()
      setupRefs(result, div, target)

      act(() => {
        result.current.resetUserScroll()
      })
      writes.length = 0

      act(() => {
        rerender({ deps: ['b'] })
      })

      // Unmount before the pending frame fires — cleanup must cancel it.
      unmount()
      flushFrame()

      expect(writes.length).toBe(0)
    })
  })

  describe('IntersectionObserver lifecycle', () => {
    it('creates the observer once and does not rebuild it when dependencies change', () => {
      const realIntersectionObserver = globalThis.IntersectionObserver
      const counts = { construction: 0, observe: 0, disconnect: 0 }

      class CountingObserver {
        constructor(_callback: IntersectionObserverCallback) {
          counts.construction += 1
        }
        observe() {
          counts.observe += 1
        }
        disconnect() {
          counts.disconnect += 1
        }
        unobserve() {}
        takeRecords(): IntersectionObserverEntry[] {
          return []
        }
      }
      globalThis.IntersectionObserver = CountingObserver as unknown as typeof IntersectionObserver

      try {
        const { result, rerender } = renderHook(
          ({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }),
          { initialProps: { deps: ['a'] } },
        )

        const container = createMockContainer(0, 1000, 500)
        const target = createMockTarget()
        setupRefs(result, container, target)

        expect(counts.construction).toBe(1)
        expect(counts.observe).toBe(1)

        // Burst of dependency changes (streamed tokens) must not tear down / rebuild it.
        act(() => {
          rerender({ deps: ['b'] })
          rerender({ deps: ['c'] })
          rerender({ deps: ['d'] })
        })

        expect(counts.construction).toBe(1)
        expect(counts.disconnect).toBe(0)
        expect(counts.observe).toBe(1)
      } finally {
        globalThis.IntersectionObserver = realIntersectionObserver
      }
    })
  })
})
