import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useAutoScroll } from './use-auto-scroll'

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
        result.current.scrollHandlers.onWheel({ deltaY: -100 } as React.WheelEvent)
      })

      const scrollTopBefore = container.scrollTop

      // Change dependencies - should NOT auto-scroll since user scrolled up
      act(() => {
        rerender({ deps: ['b'] })
      })

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
        result.current.scrollHandlers.onWheel({ deltaY: 100 } as React.WheelEvent)
      })

      // Change dependencies - should still auto-scroll
      act(() => {
        rerender({ deps: ['b'] })
      })

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
        result.current.scrollHandlers.onTouchStart({} as React.TouchEvent)
      })

      const scrollTopBefore = container.scrollTop

      // Change dependencies - should NOT auto-scroll since user touched
      act(() => {
        rerender({ deps: ['b'] })
      })

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
      expect(container.scrollTop).toBe(0)

      // Enable auto-scroll
      act(() => {
        result.current.resetUserScroll()
      })

      // Now changing deps should scroll
      act(() => {
        rerender({ deps: ['c'] })
      })
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

      expect(container.scrollTop).toBe(500)
    })
  })
})
